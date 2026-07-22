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
// come before more-general ones. `git-history` is checked before `tdd` etc.
const RULES: readonly IntentRule[] = [
	{
		// Mining git history (forbidden in simulations). Catches `git log/show/
		// blame/reflog` whether run via execute_bash or a git_* tool.
		intent: 'git-history',
		keywords: ['git log', 'git show', 'git blame', 'git reflog'],
	},
	{
		// Worktree creation — hand-rolled or scripted. The /worktree hand-roll
		// case from the simulation: `git worktree add`, `mkdir` of a worktrees
		// path, worktree-create.sh, .gitopolis reads. A bare read over an
		// existing worktree path is deliberately NOT creation (finding #5) —
		// see `matchesWorktreeCreation`.
		intent: 'worktree-creation',
		predicate: matchesWorktreeCreation,
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
];

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
