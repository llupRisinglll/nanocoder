/**
 * Deterministic intent classification for steering.
 *
 * Maps a turn's tool calls to a coarse {@link IntentClass} via keyword rules
 * over tool name + serialized arguments. This is deliberately cheap and
 * imperfect: a misclassified intent at worst produces a low-harm nudge (the
 * model says "I'm not doing that"), because InnerDaemon's first job is to reject
 * false alarms. No LLM call — runs every turn.
 *
 * Keywords were chosen from the Hilinga simulation transcripts
 * (`docs/hilinga-nanocoder-clean-run-capture.txt`): the worktree hand-roll and
 * runtime-setup death-spiral are the two canonical cases v1 must detect.
 */

import type {IntentClass} from '@/steering/types';
import type {ToolCall} from '@/types/core';

/** Serialize a tool call's arguments to a searchable string. */
export function serializeToolArgs(
	args: ToolCall['function']['arguments'],
): string {
	if (args == null) return '';
	if (typeof args === 'string') return args;
	try {
		return JSON.stringify(args);
	} catch {
		return String(args);
	}
}

/** Combined `name + serialized-args` blob for one tool call, lowercased. */
function toolCallBlob(tc: ToolCall): string {
	const name = tc.function?.name ?? '';
	const args = serializeToolArgs(tc.function?.arguments);
	return `${name} ${args}`.toLowerCase();
}

interface IntentRule {
	readonly intent: IntentClass;
	/** Match if the per-tool-call blob contains any of these substrings. */
	readonly keywords?: string[];
	/**
	 * Custom per-blob predicate, used when a plain substring list over-matches.
	 * When present, takes the place of {@link keywords} for this rule.
	 */
	readonly predicate?: (blob: string) => boolean;
}

/**
 * Standalone worktree operations that classify as `worktree-creation` on their
 * own — the tool itself IS the create/remove op (`git worktree add`, the
 * verified scripts, or a `.gitopolis` batch config read for the multi-repo
 * worktree).
 */
const WORKTREE_OP_KEYWORDS = [
	'git worktree',
	'worktree-create',
	'worktree-remove',
	'.gitopolis',
];

/**
 * Creation/mutation verbs that, when co-occurring with a `.claude/worktrees/`
 * PATH reference, mean the model is (hand-)creating a worktree.
 */
const WORKTREE_CREATION_VERBS = [
	'mkdir',
	'git worktree add',
	'worktree-create',
];

/**
 * Classify `worktree-creation` precisely (finding #5). A standalone worktree
 * op always classifies. A bare `.claude/worktrees/<name>` PATH reference
 * classifies ONLY when it co-occurs with a creation/mutation verb (the
 * hand-roll `mkdir .claude/worktrees/x` this rule targets) — NOT when it merely
 * co-occurs with a read op (`ls`/`cat`/`grep`/`find`/`head`/`tail`), which is
 * just inspecting an existing worktree. The old classifier tagged EVERY path
 * reference as worktree-creation, so reproduce/TDD/fix turns kept the rule in
 * scope.
 */
function matchesWorktreeCreation(blob: string): boolean {
	if (WORKTREE_OP_KEYWORDS.some(kw => blob.includes(kw))) return true;
	if (blob.includes('.claude/worktrees/')) {
		return WORKTREE_CREATION_VERBS.some(v => blob.includes(v));
	}
	return false;
}

// Order matters: the FIRST matching rule wins, so more-specific classes must
// come before more-general ones. `worktree-creation` is checked FIRST: a
// hand-roll turn routinely mixes `git worktree add` with a `git log` probe, and
// if `git-history` won that turn it would fall out of worktree-supervision's
// scope — the exact gap that let a hand-rolled single-repo worktree slip past
// supervision in the sim. Worktree tooling is the dominant intent when present.
const RULES: readonly IntentRule[] = [
	{
		// Worktree creation — hand-rolled or scripted (`git worktree add`, `mkdir`
		// of a worktrees path, worktree-create.sh, .gitopolis reads). A bare read
		// over an existing worktree path is deliberately NOT creation (finding #5)
		// — see `matchesWorktreeCreation`. Kept ahead of `git-history` so a turn
		// that both adds a worktree and probes history stays worktree-creation.
		intent: 'worktree-creation',
		predicate: matchesWorktreeCreation,
	},
	{
		// Mining git history (forbidden in simulations). Catches `git log/show/
		// blame/reflog` whether run via execute_bash or a git_* tool.
		intent: 'git-history',
		keywords: ['git log', 'git show', 'git blame', 'git reflog'],
	},
	{
		// Multi-repo batch git via gitopolis. Very specific single keyword.
		intent: 'gitopolis',
		keywords: ['gitopolis'],
	},
	{
		// Committing / staging — surfaces the commit-discipline announce.
		intent: 'commit',
		keywords: ['git commit', 'git add '],
	},
	{
		// Creating/editing a PR via bash (the model doing it autonomously, NOT the
		// user typing `/create-pr` — that already injects the command body). This
		// is the non-redundant case where the create-pr skill needs surfacing.
		intent: 'pr-create',
		keywords: ['gh pr create', 'gh pr edit'],
	},
	{
		// Creating a GitHub issue — surfaces the don't-create-issues discipline
		// (finish in-session unless the user explicitly asked for an issue).
		intent: 'issue-create',
		keywords: ['gh issue create'],
	},
	{
		// Operating / debugging the prod or CI server (pm2, /opt/kserp). NOT
		// local dev (that's runtime-setup) — checked first so a pm2 turn is
		// prod-ops, not misread as dev-server setup.
		intent: 'prod-ops',
		keywords: ['pm2 ', '/opt/kserp'],
	},
	{
		// Runtime/dev-server setup — the death-spiral class. dev server launch,
		// DB restore/migrate, port probing, plugin node_modules wiring.
		intent: 'runtime-setup',
		keywords: [
			'vinxi',
			'concurrently',
			'db:from-prod',
			'npm run dev',
			'pnpm run dev',
			'bun run dev',
			'pnpm install',
			'npm install',
			'node_modules',
			'psql',
			'db:migrate',
			'ss -ltn',
			'localhost:',
		],
	},
	{
		// CI/CD pipeline work — surfaces the hilinga-cicd announce.
		intent: 'ci',
		keywords: ['deploy.yml', 'plugin-ci', 'plugin_token', 'gh pr checks'],
	},
	{
		// Release sequencing — changeset authoring is the strong, specific signal
		// (bare branch creation is deliberately NOT here — too broad).
		intent: 'branch-release',
		keywords: ['.changeset', 'changeset add'],
	},
	{
		// Writing a migration / schema / RLS — surfaces the migration announce.
		// Strong DDL signals only (bare `.sql` omitted to avoid firing on reads).
		intent: 'migration-sql',
		keywords: [
			'create table',
			'alter table',
			'create policy',
			'row level security',
			'kernel_migrations',
		],
	},
	{
		// TDD — writing/running tests. test runners, spec files, vitest/jest.
		intent: 'tdd',
		keywords: [
			'.spec.ts',
			'.test.ts',
			'.spec.tsx',
			'.test.tsx',
			'vitest',
			'jest',
			'npm test',
			'pnpm test',
			'test:types',
		],
	},
	{
		// Timezone/date work (SQL + specs). Checked AFTER tdd so a timezone test
		// file still classifies `tdd`; this catches non-test timezone SQL.
		intent: 'timezone-date',
		keywords: ['at time zone', 'asia/manila', 'timestamptz', '::date'],
	},
	{
		// Security-sensitive code — best-effort detection (LOW confidence, tight
		// keyword set to limit over-fire). Surfaces the security-audit skill.
		// Misses are expected: the user still invokes security-audit manually for
		// security work the detector can't see.
		intent: 'security-sensitive',
		keywords: [
			'password_hash',
			'bcrypt',
			'multipart/form-data',
			'cf_connecting_ip',
			'x-api-key',
			'auth.workspace_id',
		],
	},
	{
		// Reusable-lib / build-mechanics work (ksui, plugin-sdk, package build).
		// Scoped to library/build signals, NOT the over-broad `kplugin_` path.
		intent: 'pluginlib',
		keywords: ['build:packages', '@kahitsan/plugin-sdk', 'vite.remote.config'],
	},
	{
		// Taking a Playwright screenshot — the ONLY signal the screenshots
		// reference fact is relevant (scoped to the screenshot tool, not all
		// browser navigation).
		intent: 'playwright-ui',
		keywords: ['browser_take_screenshot'],
	},
	{
		// Pre-PR verification gates — surfaces the hilinga-verify skill. Test
		// RUNNERS are `tdd`; these are the type-check / lint / dead-code gates
		// run when wrapping up a task.
		intent: 'verify',
		keywords: ['tsc --noemit', 'eslint', 'knip', 'dependency-cruiser'],
	},
];

/**
 * Read/search-only tool names — a turn built entirely from these (plus an
 * `explore`/`plan` `agent` delegation) is investigation, not action.
 */
const READ_ONLY_TOOLS = new Set([
	'read_file',
	'read_many_files',
	'grep',
	'find',
	'search_file_contents',
	'list_directory',
	'glob',
]);

/**
 * True if a single tool call is investigation-only: a read/search tool, or an
 * `agent` delegation whose args name `explore`/`plan`.
 */
function isReproduceProxyCall(tc: ToolCall): boolean {
	const name = (tc.function?.name ?? '').toLowerCase();
	if (READ_ONLY_TOOLS.has(name)) return true;
	if (name === 'agent') {
		const args = serializeToolArgs(tc.function?.arguments).toLowerCase();
		return args.includes('explore') || args.includes('plan');
	}
	return false;
}

/**
 * `reproduce` proxy (reproduction-first draft): the turn is read/search-only
 * (every call is a read tool or an `explore`/`plan` `agent` delegation) AND no
 * `browser_*` call occurred. LIMITATION: `classifyIntent` sees only the current
 * turn, so "no browser call yet THIS LOOP" is approximated as "no browser call
 * this TURN" (a read-only turn has none by construction). A read-only turn that
 * happens AFTER a browser reproduction still classifies `reproduce`; that is
 * acceptable because the loop-stateful `uiDrivenOrAppRun` criterion — not this
 * classifier — is the real lever that makes the rule dormant once reproduction
 * has happened (mirrors the finding-#5 resolution: fix the criterion, not the
 * classifier). Full task-kind threading into `TurnFact` is out of scope.
 */
function matchesReproduce(toolCalls: ToolCall[]): boolean {
	if (
		toolCalls.some(tc =>
			(tc.function?.name ?? '').toLowerCase().startsWith('browser_'),
		)
	) {
		return false;
	}
	return toolCalls.every(isReproduceProxyCall);
}

/**
 * Classify the dominant intent of a turn from its tool calls.
 *
 * Returns `'unknown'` for a no-tool-call (pure text) turn, or when no rule
 * matches. When multiple tool calls map to different intents, the highest-
 * priority matching rule (earliest in {@link RULES}) wins — we care about the
 * most actionable signal, and a `git log` inside a runtime-setup turn is still
 * history-mining.
 */
export function classifyIntent(toolCalls: ToolCall[]): IntentClass {
	if (!toolCalls || toolCalls.length === 0) return 'unknown';

	// Build per-call blobs once.
	const blobs = toolCalls.map(toolCallBlob);

	for (const rule of RULES) {
		const matched = blobs.some(blob =>
			rule.predicate
				? rule.predicate(blob)
				: (rule.keywords ?? []).some(kw => blob.includes(kw)),
		);
		if (matched) return rule.intent;
	}

	// Frontend-edit heuristic: an edit/write tool touching a .tsx/.css path
	// under ui/ or a component dir. Check the actual path arg value (not the
	// serialized JSON blob, which wouldn't end in `.tsx`).
	const frontendEdit = toolCalls.some(tc => {
		const name = tc.function?.name ?? '';
		const isEdit = name === 'write_file' || name === 'string_replace';
		if (!isEdit) return false;
		const args = tc.function?.arguments;
		const rawPath =
			(typeof args === 'object' && args !== null
				? ((args.path as string) ?? (args.file_path as string))
				: undefined) ?? '';
		const p = rawPath.toLowerCase();
		return (
			p.endsWith('.tsx') ||
			p.endsWith('.css') ||
			p.startsWith('ui/') ||
			p.includes('/ui/') ||
			p.includes('components/')
		);
	});
	if (frontendEdit) return 'frontend-edit';

	// Reproduce: a purely investigative turn (read/search or explore/plan
	// delegation, no browser). Checked LAST so any keyword-bearing action class
	// (git-history, runtime-setup, tdd, worktree, frontend-edit) wins first.
	if (matchesReproduce(toolCalls)) return 'reproduce';

	return 'unknown';
}

/**
 * Check whether a single tool call violates a substring constraint
 * (used by `watch.alsoBlock`). Returns the matched keyword or null.
 */
export function matchingArgSubstring(
	toolCall: ToolCall,
	toolName: string,
	substrings: string[],
): string | null {
	const name = toolCall.function?.name ?? '';
	if (name !== toolName) return null;
	const blob = toolCallBlob(toolCall);
	for (const sub of substrings) {
		if (blob.includes(sub.toLowerCase())) return sub;
	}
	return null;
}
