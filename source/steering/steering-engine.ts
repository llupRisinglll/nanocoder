/**
 * The steering engine — orchestrates detector + InnerDaemon into a single
 * `evaluate()` call the conversation loop makes at each turn boundary.
 *
 * Flow per turn:
 *  1. **Instant constraint check** — `detectConstraintViolations` scans the
 *     latest turn for any rule's `watch.alsoBlock` substring violations. A hit
 *     produces a `block` action immediately (no InnerDaemon call, no budget).
 *  2. **Candidate detection** — `evaluateRules` finds rules whose condition
 *     matches AND whose budget is exhausted without the success criterion met.
 *  3. **Per-candidate action** — `detector-only` rules act directly; `innerdaemon`
 *     rules invoke InnerDaemon. Either way, per-rule fire-count + cooldown state
 *     is consulted: rules in cooldown are skipped; rules at `maxFires` escalate
 *     to `stop` rather than nagging.
 *
 * The first non-noop action wins (we don't stack multiple steering messages in
 * one turn — one forcing nudge at a time, proven optimal in simulation).
 *
 * See `docs/auto-steering-architecture.md` §2, §4.4.
 */

import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
	DEFAULT_STEERING_COOLDOWN_TURNS,
	DEFAULT_STEERING_MAX_FIRES,
} from '@/constants';
import {
	describeInScope,
	detectConstraintViolations,
	evaluateRules,
	type SuccessCriterionChecker,
} from '@/steering/detector';
import {
	innerdaemonResponseToAction,
	invokeInnerDaemon,
} from '@/steering/innerdaemon';
import {serializeToolArgs} from '@/steering/intent-classifier';
import {
	type InnerDaemonRequest,
	type InnerDaemonResponse,
	type SteeringAction,
	type SteeringCandidate,
	type SteeringDiagnostic,
	type SteeringRule,
	type TurnFact,
} from '@/steering/types';
import {getLogger} from '@/utils/logging';

const logger = getLogger();

/**
 * InnerDaemon invoker abstraction so the engine is unit-testable with a mock.
 * The real implementation is {@link invokeInnerDaemon} (which needs a
 * SubagentExecutor); tests inject a stub.
 */
export type InnerDaemonInvoker = (
	req: InnerDaemonRequest,
	signal?: AbortSignal,
) => Promise<InnerDaemonResponse>;

/** Options for a single {@link SteeringEngine.evaluate} call. */
export interface EvaluateOptions {
	/**
	 * When set, the engine reports a cheap {@link SteeringDiagnostic} for this
	 * evaluation (verbose "proof-of-life" mode). Leaving it undefined keeps the
	 * hot path allocation-light and behavior-identical.
	 */
	onDiagnostic?: (diagnostic: SteeringDiagnostic) => void;
}

/**
 * Escalation ladder (finding #9 — "no escalation on relapse"). Repeated firing
 * of the SAME rule without its success criterion being met is a RELAPSE; each
 * successive fire should get firmer instead of re-nudging identically. The
 * level is the rule's PRIOR fire count ({@link RuleFireState.count} before this
 * fire is recorded):
 *
 *   level 0 (first fire):        inject, urgency 'light'  — byte-identical.
 *   level 1 (second fire):       inject, urgency 'firm'   — firmer re-nudge.
 *   level 2 (third fire):        inject, urgency 'firm'   — still a firm nudge.
 *   level ≥ {@link ESCALATE_BLOCK_LEVEL} (persistent relapse):
 *                                upgrade inject → block   — stop re-nudging.
 *
 * The `maxFires → stop` backstop is UNCHANGED and is consulted BEFORE this
 * ladder: once `count ≥ maxFires` the candidate is a hard `stop`. So a rule
 * with the default maxFires (3) climbs nudge → firm → firm → stop, and only
 * rules with a larger maxFires reach the block rung — which keeps the existing
 * maxFires-backstop behavior (three injects then stop) intact. A non-`inject`
 * action (a native InnerDaemon block/stop) is already terminal and passes
 * through unescalated. `escalationLevel` is ALSO threaded into the InnerDaemon
 * request so InnerDaemon can raise its OWN message firmness independently.
 */
const ESCALATE_BLOCK_LEVEL = 3;

function escalateAction(action: SteeringAction, level: number): SteeringAction {
	if (action.type !== 'inject') return action;
	if (level >= ESCALATE_BLOCK_LEVEL) {
		return {
			type: 'block',
			message: action.message,
			urgency: 'firm',
			ruleId: action.ruleId,
		};
	}
	if (level >= 1) {
		return {...action, urgency: 'firm'};
	}
	return action;
}

/** Map a real {@link SteeringAction} type to its diagnostic decision label. */
function mapDecision(
	type: 'inject' | 'block' | 'stop',
): SteeringDiagnostic['decision'] {
	return type === 'inject' ? 'nudge' : type;
}

export interface SteeringEngineOptions {
	/** All loaded steering rules (from SteeringRuleLoader). */
	rules: SteeringRule[];
	/** Active model id (for the condition model gate). */
	modelId: string;
	/** Observable success-criterion checker (engine builds this from cwd etc). */
	criterionChecker: SuccessCriterionChecker;
	/**
	 * InnerDaemon invoker. Defaults to the real {@link invokeInnerDaemon} bound to a
	 * SubagentExecutor; tests pass a mock.
	 */
	innerdaemon?: InnerDaemonInvoker;
}

/**
 * Mutable steering state, carried across turns within one conversation loop.
 * The engine holds it; the conversation loop holds the engine.
 */
interface EngineState {
	/** Per-rule fire tracking, keyed by rule id. */
	fires: Map<string, {count: number; lastFireTurn: number}>;
}

export class SteeringEngine {
	private rules: SteeringRule[];
	private modelId: string;
	private readonly checker: SuccessCriterionChecker;
	private innerdaemon: InnerDaemonInvoker;
	private state: EngineState = {fires: new Map()};

	constructor(opts: SteeringEngineOptions) {
		this.rules = opts.rules;
		this.modelId = opts.modelId;
		this.checker = opts.criterionChecker;
		this.innerdaemon =
			opts.innerdaemon ??
			(async () => {
				// The real invoker needs a SubagentExecutor, which isn't available
				// at construction time. bindExecutor() sets it at wiring time.
				throw new Error(
					'SteeringEngine: InnerDaemon invoked without a bound executor. Call bindExecutor() at wiring time.',
				);
			});
	}

	/**
	 * Bind a real InnerDaemon invoker (carrying a SubagentExecutor) after
	 * construction. Called once at wiring time from useChatHandler, once the
	 * SubagentExecutor is available.
	 */
	bindExecutor(
		executor: import('@/subagents/subagent-executor').SubagentExecutor,
	): void {
		this.innerdaemon = (req, signal) =>
			invokeInnerDaemon(executor, req, signal);
	}

	/** Replace the active model id (call when the user switches models). */
	setModelId(modelId: string): void {
		this.modelId = modelId;
	}

	/** Replace the loaded rules (call after a config reload). */
	setRules(rules: SteeringRule[]): void {
		this.rules = rules;
		this.state.fires.clear();
	}

	/** Reset all fire/cooldown state (e.g. at the start of a new user turn). */
	resetFireState(): void {
		this.state.fires.clear();
	}

	/**
	 * Evaluate the current turn and return at most one steering action.
	 *
	 * @param facts   Accumulated turn history (most recent last).
	 * @param signal  Abort signal for the InnerDaemon call.
	 * @param opts    Optional diagnostics collection (verbose "proof-of-life").
	 *                When `opts.onDiagnostic` is set, the engine reports a cheap
	 *                {@link SteeringDiagnostic} describing THIS evaluation. The
	 *                extra work runs only in that case — the non-verbose hot path
	 *                is byte-for-byte the original logic.
	 * @returns A {@link SteeringAction}, or null to steer nothing this turn.
	 */
	async evaluate(
		facts: TurnFact[],
		signal?: AbortSignal,
		opts?: EvaluateOptions,
	): Promise<SteeringAction | null> {
		const emit = opts?.onDiagnostic;
		if (facts.length === 0) {
			if (emit) {
				emit({
					intentClass: 'unknown',
					inScopeRuleId: null,
					budgetUsed: 0,
					budgetMax: 0,
					decision: 'noop',
				});
			}
			return null;
		}

		// 1. Instant hard-constraint violations (detector-only, no budget).
		const violation = detectConstraintViolations(facts, this.rules);
		if (violation) {
			logger.info('steering: constraint violation → block', {
				ruleId: violation.rule.id,
				matched: violation.matched,
			});
			if (emit) emit(this.buildDiagnostic(facts, 'block'));
			return {
				type: 'block',
				toolCallIds: [violation.toolCallId],
				message: violation.constraint.message,
				urgency: 'light',
				ruleId: violation.rule.id,
			};
		}

		// 2. Budget-exhausted candidates.
		const candidates = evaluateRules(
			facts,
			this.rules,
			this.modelId,
			this.checker,
		);
		if (candidates.length === 0) {
			if (emit) emit(this.buildDiagnostic(facts, 'noop'));
			return null;
		}

		// 3. Apply the first eligible candidate (respecting cooldown + maxFires).
		for (const candidate of candidates) {
			const action = await this.evaluateCandidate(candidate, facts, signal);
			// A noop candidate is skipped — try the next one. A real action wins.
			if (action && action.type !== 'noop') {
				if (emit) emit(this.buildDiagnostic(facts, mapDecision(action.type)));
				return action;
			}
		}
		if (emit) emit(this.buildDiagnostic(facts, 'noop'));
		return null;
	}

	/**
	 * Build a verbose diagnostic for the current evaluation. Called ONLY when
	 * diagnostics are requested. The {@link SteeringDiagnostic.decision} is passed
	 * in from the real evaluation above (never recomputed); the in-scope rule and
	 * budget come from {@link describeInScope}, which reuses the exact detector
	 * primitives — so the trace can never disagree with the real steering path.
	 */
	private buildDiagnostic(
		facts: TurnFact[],
		decision: SteeringDiagnostic['decision'],
	): SteeringDiagnostic {
		const latest = facts[facts.length - 1];
		const inScope = describeInScope(
			facts,
			this.rules,
			this.modelId,
			this.checker,
		);
		return {
			intentClass: latest.intentClass,
			inScopeRuleId: inScope?.rule.id ?? null,
			budgetUsed: inScope?.budgetUsed ?? 0,
			budgetMax: inScope?.budgetMax ?? 0,
			decision,
		};
	}

	/** Evaluate a single candidate, consulting/mutating per-rule fire state. */
	private async evaluateCandidate(
		candidate: SteeringCandidate,
		facts: TurnFact[],
		signal?: AbortSignal,
	): Promise<SteeringAction | null> {
		const {rule} = candidate;
		const maxFires = rule.maxFires ?? DEFAULT_STEERING_MAX_FIRES;
		const cooldown = rule.cooldownTurns ?? DEFAULT_STEERING_COOLDOWN_TURNS;

		const st = this.state.fires.get(rule.id) ?? {
			count: 0,
			lastFireTurn: -Infinity,
		};

		// announce rules: proactive one-shot scenario-context injection. The moment
		// the scenario is in scope, inject the rule body (a fixed preference — no
		// InnerDaemon call, no judgment) up to `maxFires` (default 1), then go
		// DORMANT. Unlike corrective rules it NEVER stop-escalates: an
		// already-surfaced preference has nothing firmer to escalate to. This is
		// how scenario-specific guidance (frontend prefs, PR prefs, E2E discipline)
		// stays OUT of the always-on AGENTS.md and surfaces only when relevant.
		if (rule.mode === 'announce') {
			if (st.count >= (rule.maxFires ?? 1)) return null;
			if (
				rule.cooldownTurns !== undefined &&
				candidate.turnIndex - st.lastFireTurn < rule.cooldownTurns
			) {
				return null;
			}
			this.recordFire(rule.id, candidate.turnIndex);
			return {
				type: 'inject',
				message: rule.body ?? '',
				urgency: 'light',
				ruleId: rule.id,
			};
		}

		// Relapse-escalation level = how many times this rule has ALREADY fired
		// without progress (0 on the first fire → byte-identical nudge). Threaded
		// into the InnerDaemon request AND used to upgrade a repeated inject at
		// the top level (see escalateAction).
		const escalationLevel = st.count;

		// Escalation: rule already fired maxFires times → hard stop.
		if (st.count >= maxFires) {
			logger.info('steering: maxFires exceeded → stop', {
				ruleId: rule.id,
				fires: st.count,
			});
			return {
				type: 'stop',
				reason: `Steering rule '${rule.id}' fired ${st.count} times without progress. Stopping to avoid an unproductive loop. Last nudge was not followed.`,
			};
		}

		// Cooldown: don't re-fire too soon after the last fire.
		if (candidate.turnIndex - st.lastFireTurn < cooldown) {
			return null;
		}

		// detector-only rules act directly (no InnerDaemon call).
		if (rule.mode === 'detector-only') {
			this.recordFire(rule.id, candidate.turnIndex);
			return escalateAction(
				{
					type: 'inject',
					message: this.detectorOnlyMessage(rule, candidate),
					urgency: 'light',
					ruleId: rule.id,
				},
				escalationLevel,
			);
		}

		// innerdaemon rules delegate to the secondary thinker.
		const req = this.buildRequest(rule, candidate, facts, escalationLevel);
		const response = await this.innerdaemon(req, signal);
		const raw = innerdaemonResponseToAction(response);
		// Tag inject/block actions with the rule id so the trace header can name
		// which steering script fired (noop/stop carry no header).
		const action: SteeringAction =
			raw.type === 'inject' || raw.type === 'block'
				? {...raw, ruleId: rule.id}
				: raw;

		// Only count a fire if InnerDaemon actually steered (noop doesn't consume
		// a fire slot — a false alarm shouldn't burn the escalation budget).
		if (action.type !== 'noop') {
			this.recordFire(rule.id, candidate.turnIndex);
			// Relapse upgrade: a repeated inject gets firmer / becomes a block as
			// the escalation level climbs (the maxFires stop backstop already
			// handled the terminal rung above).
			return escalateAction(action, escalationLevel);
		}
		return action;
	}

	private recordFire(ruleId: string, turnIndex: number): void {
		const st = this.state.fires.get(ruleId) ?? {
			count: 0,
			lastFireTurn: -Infinity,
		};
		st.count += 1;
		st.lastFireTurn = turnIndex;
		this.state.fires.set(ruleId, st);
	}

	private buildRequest(
		rule: SteeringRule,
		candidate: SteeringCandidate,
		facts: TurnFact[],
		escalationLevel: number,
	): InnerDaemonRequest {
		const latest = facts[facts.length - 1];
		const criterion = rule.watch?.successCriterion;
		const criterionMet =
			criterion && criterion !== 'none'
				? this.checker(criterion, latest, facts)
				: undefined;
		// Surface the loop-stateful impl-before-test ordering VIOLATION to
		// InnerDaemon independently of this rule's own successCriterion. This is
		// what lets `tdd-discipline` (which watches `newTestFileExists` for its
		// budget gate) hand InnerDaemon the anti-criterion it actually decides on —
		// see docs/innerdaemon-steering-findings.md finding #8. Cheap loop scan; a
		// non-tdd rule simply never reads the surfaced signal in its prompt.
		const implEditedBeforeTest = this.checker(
			'implEditedBeforeTest',
			latest,
			facts,
		);
		return {
			ruleId: rule.id,
			ruleBody: rule.body ?? '',
			situation: {
				modelId: this.modelId,
				intentClass: latest.intentClass,
				recentTurns: facts,
				triggerReason: candidate.reason,
				successCriterion: criterion,
				criterionMet,
				implEditedBeforeTest,
				escalationLevel,
			},
		};
	}

	/** Default nudge text for a detector-only rule (no InnerDaemon involved). */
	private detectorOnlyMessage(
		rule: SteeringRule,
		candidate: SteeringCandidate,
	): string {
		return `[${rule.id}] ${candidate.reason}. ${rule.body ? rule.body.split('\n')[0] : ''}`.trim();
	}
}

/**
 * Extract candidate TCP ports referenced by a turn: every `localhost:<port>`
 * mention in the serialized tool calls/results, plus any `*PORT=` entry in the
 * worktree `.env` (best-effort, sync). Deduplicated. Used by the stateful
 * `portListenerExists` criterion to decide which ports to socket-probe.
 */
function extractReferencedPorts(blob: string, cwd: string): number[] {
	const ports = new Set<number>();
	const re = /localhost:(\d{2,5})/g;
	let m: RegExpExecArray | null = re.exec(blob);
	while (m !== null) {
		const p = Number.parseInt(m[1], 10);
		if (p > 0 && p < 65536) ports.add(p);
		m = re.exec(blob);
	}
	// Also consult the worktree `.env` for a declared port (best-effort).
	try {
		const envPath = join(cwd, '.env');
		if (existsSync(envPath)) {
			const env = readFileSync(envPath, 'utf8');
			for (const e of env.matchAll(/^[A-Z0-9_]*PORT\s*=\s*"?(\d{2,5})"?/gm)) {
				const p = Number.parseInt(e[1], 10);
				if (p > 0 && p < 65536) ports.add(p);
			}
		}
	} catch {
		// `.env` is optional — ignore and rely on the blob-extracted ports.
	}
	return [...ports];
}

/**
 * Synchronously check whether any local socket is in the LISTEN state on
 * `port`, by parsing `/proc/net/tcp` + `/proc/net/tcp6` (Linux only). Each row
 * is `sl local_address rem_address st …`; `local_address` is `HEXIP:HEXPORT`
 * and `st == 0A` is TCP_LISTEN. Returns false on any non-Linux platform or
 * parse failure so the caller falls back to the output heuristic. The steering
 * checker is synchronous by contract, so this avoids an async socket probe.
 */
function isPortListeningSync(port: number): boolean {
	if (process.platform !== 'linux') return false;
	const TCP_LISTEN = '0A';
	for (const path of ['/proc/net/tcp', '/proc/net/tcp6']) {
		try {
			const lines = readFileSync(path, 'utf8').split('\n');
			// Skip the header row (index 0).
			for (let i = 1; i < lines.length; i++) {
				const cols = lines[i].trim().split(/\s+/);
				if (cols.length < 4) continue;
				if (cols[3] !== TCP_LISTEN) continue;
				const portHex = cols[1].split(':')[1];
				if (portHex && Number.parseInt(portHex, 16) === port) return true;
			}
		} catch {
			// This table may be absent (e.g. no IPv6) — try the next one.
		}
	}
	return false;
}

/** True if a tool call is a `browser_*` MCP call (a UI-drive). */
function isBrowserCall(tc: import('@/types/core').ToolCall): boolean {
	return (tc.function?.name ?? '').toLowerCase().startsWith('browser_');
}

/** Lowercased `name + serialized-args` blob for one tool call. */
function callBlob(tc: import('@/types/core').ToolCall): string {
	const name = tc.function?.name ?? '';
	const args = serializeToolArgs(tc.function?.arguments);
	return `${name} ${args}`.toLowerCase();
}

/** Keywords that mark an app / dev-server run (reproduction-first). */
const APP_RUN_KEYWORDS = [
	'npm run dev',
	'pnpm run dev',
	'bun run dev',
	'yarn dev',
	'vinxi dev',
	'vinxi start',
];

/** Keywords that mark a test run (over-exploration artifact signal). */
const TEST_RUN_KEYWORDS = [
	'npm test',
	'pnpm test',
	'pnpm run test',
	'bun test',
	'vitest',
	'jest',
	'npx ava',
	'test:ava',
	'ava ',
];

/** The tool-result paired with a tool call (by id), if any. */
function resultFor(
	fact: TurnFact,
	tc: import('@/types/core').ToolCall,
): import('@/types/core').ToolResult | undefined {
	return fact.toolResults.find(r => r.tool_call_id === tc.id);
}

/** True if a paired tool result indicates an error (or errory content). */
function resultIsError(r?: import('@/types/core').ToolResult): boolean {
	if (!r) return false;
	return (
		r.isError === true || /error|not found|failed|econnrefused/i.test(r.content)
	);
}

/** True if the fact ran an app / dev server without an error result. */
function factHasAppRun(fact: TurnFact): boolean {
	return fact.toolCalls.some(tc => {
		const blob = callBlob(tc);
		if (!APP_RUN_KEYWORDS.some(kw => blob.includes(kw))) return false;
		return !resultIsError(resultFor(fact, tc));
	});
}

/** True if the fact ran a test (any test-runner keyword in a tool call). */
function factHasTestRun(fact: TurnFact): boolean {
	return fact.toolCalls.some(tc => {
		const blob = callBlob(tc);
		return TEST_RUN_KEYWORDS.some(kw => blob.includes(kw));
	});
}

/** Path a write/edit tool targets this call, or undefined for a non-edit. */
function editPath(tc: import('@/types/core').ToolCall): string | undefined {
	const name = tc.function?.name ?? '';
	if (name !== 'write_file' && name !== 'string_replace') return undefined;
	const a = tc.function?.arguments;
	const p =
		a && typeof a === 'object'
			? ((a.path as string) ?? (a.file_path as string))
			: undefined;
	return typeof p === 'string' ? p : undefined;
}

/** Matches a `.spec.ts(x)` / `.test.ts(x)` path. */
const SPEC_PATH_RE = /\.spec\.t(s|sx)|\.test\.t(s|sx)/;

/** True if the fact wrote/edited a spec/test file. */
function factWroteTestFile(fact: TurnFact): boolean {
	return fact.toolCalls.some(tc => {
		const p = editPath(tc);
		return p !== undefined && SPEC_PATH_RE.test(p);
	});
}

/** True if the fact wrote/edited a NON-spec/test (implementation) source file. */
function factWroteImplFile(fact: TurnFact): boolean {
	return fact.toolCalls.some(tc => {
		const p = editPath(tc);
		return p !== undefined && !SPEC_PATH_RE.test(p);
	});
}

/** True if the fact produced ANY concrete artifact (edit, browser, test run). */
function factProducedArtifact(fact: TurnFact): boolean {
	return (
		fact.toolCalls.some(tc => editPath(tc) !== undefined) ||
		fact.toolCalls.some(isBrowserCall) ||
		factHasTestRun(fact)
	);
}

/**
 * Build a success-criterion checker bound to a worktree-root / cwd context.
 * The conversation loop passes the current cwd; v1 implements the observable
 * predicates as cheap fs/socket checks. Phase 3 swaps these for the events
 * file-watcher.
 *
 * The fs-backed criteria (`worktreeDirExists`, `portListenerExists`,
 * `newTestFileExists`) read only the single `fact` and ignore `facts` — their
 * two-arg call sites and behavior are unchanged. The LOOP-STATEFUL criteria
 * (`uiDrivenOrAppRun`, `artifactProducedThisTask`, `implEditedBeforeTest`) scan
 * the `facts` task prefix, so they answer "did X ever happen this task?" and
 * stay met (or, for the anti-criterion, stay tripped) once the condition holds.
 * When `facts` is omitted the scope defaults to `[fact]` (single turn).
 *
 * Returned checker is safe to call repeatedly (idempotent reads).
 */
export function createCriterionChecker(
	getCwd: () => string,
): SuccessCriterionChecker {
	return (criterion, fact, facts) => {
		const scope = facts ?? [fact];
		switch (criterion) {
			case 'worktreeDirExists': {
				const cwd = fact.cwd ?? getCwd();
				if (cwd.includes('/worktrees/')) return true;
				// Stateful check: extract any `.claude/worktrees/<name>` reference
				// from this turn's tool calls/results and verify the worktree exists
				// AND is populated on disk. Being stateful (not just this turn's
				// bash output) is what keeps a create-only rule DORMANT once the
				// worktree exists — otherwise the budget climbs during later
				// reproduce/TDD/fix turns that merely reference the worktree path
				// (the false-positive `block` observed in the Hilinga sim). We
				// require a NON-EMPTY dir so a bare `mkdir` during a hand-roll (the
				// failure mode this rule targets) is not mistaken for a real
				// worktree.
				const blob = `${JSON.stringify(fact.toolCalls ?? [])} ${fact.toolResults
					.map(r => r.content)
					.join(' ')}`;
				const match = blob.match(/\.claude\/worktrees\/([A-Za-z0-9._-]+)/);
				if (match) {
					try {
						const dir = join(getCwd(), '.claude', 'worktrees', match[1]);
						if (existsSync(dir) && readdirSync(dir).length > 0) return true;
					} catch {
						// fall through to the output-based heuristic
					}
				}
				return fact.toolResults.some(
					r =>
						r.name === 'execute_bash' &&
						!/error|not found|failed/i.test(r.content) &&
						/worktree-create|worktree add/i.test(r.content),
				);
			}
			case 'portListenerExists': {
				// Stateful check: extract any `localhost:<port>` reference from this
				// turn's tool calls/results (or a `*PORT` from the worktree `.env`)
				// and verify that port is ACTUALLY listening via `/proc/net/tcp{,6}`
				// (Linux, synchronous + cheap). Being stateful (not just this turn's
				// bash output) is what keeps the runtime-setup rule DORMANT while the
				// server is genuinely up — otherwise the budget drifts up on turns
				// that don't happen to mention a live port (the `1/6 ↔ 2/6`
				// fluctuation observed in the Hilinga sim, finding #3). The checker
				// is synchronous by contract, so we parse `/proc` rather than open a
				// socket. If the referenced port is not listening (or on non-Linux /
				// parse failure / no port found) we fall back to the original
				// output-based heuristic below.
				const cwd = fact.cwd ?? getCwd();
				const blob = `${JSON.stringify(fact.toolCalls ?? [])} ${fact.toolResults
					.map(r => r.content)
					.join(' ')}`;
				for (const port of extractReferencedPorts(blob, cwd)) {
					if (isPortListeningSync(port)) return true;
				}
				return fact.toolResults.some(
					r =>
						r.name === 'execute_bash' &&
						!/error|ECONNREFUSED|not found|failed/i.test(r.content) &&
						/localhost:\d+|listening|ready in/i.test(r.content),
				);
			}
			case 'newTestFileExists': {
				return fact.toolCalls.some(
					tc =>
						(tc.function?.name === 'write_file' ||
							tc.function?.name === 'string_replace') &&
						/\.spec\.t(s|sx)|\.test\.t(s|sx)/.test(
							JSON.stringify(tc.function?.arguments ?? {}),
						),
				);
			}
			case 'uiDrivenOrAppRun': {
				// Loop-stateful: met once ANY turn of the task either drove the UI
				// (a `browser_*` call) or ran the app / dev server without error.
				// Stays met through the fix phase (scans the whole task prefix), so
				// a reproduction-first rule goes dormant after the first reproduce.
				return scope.some(
					f => f.toolCalls.some(isBrowserCall) || factHasAppRun(f),
				);
			}
			case 'artifactProducedThisTask': {
				// Loop-stateful: met once ANY turn produced a concrete artifact — a
				// `write_file`/`string_replace`, a `browser_*` call, or a test run.
				// The generic over-exploration signal: while unmet the budget climbs
				// on read/search-only turns; the first artifact resets it for good.
				return scope.some(factProducedArtifact);
			}
			case 'implEditedBeforeTest': {
				// Loop-stateful ANTI-criterion: returns TRUE once the VIOLATION has
				// occurred — an implementation (non-spec) source file was written in
				// some turn before any test file had been written earlier in the
				// task. NOTE on polarity: unlike the goal criteria, `true` here means
				// "bad ordering happened", so this is NOT wired as a positive
				// `successCriterion` in the budget gate (which fires on the criterion
				// being UNMET and would invert the intent). It is consumed as the
				// `criterionMet` signal handed to InnerDaemon (buildRequest), which
				// reads it to confirm the impl-first edit before injecting the
				// test-first nudge. Chosen over extending `SteeringToolConstraint`/
				// `alsoBlock` with a path negation because the "before a test
				// existed" clause is inherently LOOP-STATEFUL — it needs the task
				// history, which the turn-local `alsoBlock` path (it only sees the
				// latest turn) structurally cannot express, whereas the now
				// facts-aware checker can. A same-turn test+impl write counts as
				// test-first (lenient — no false violation).
				let testSeen = false;
				for (const f of scope) {
					if (factWroteTestFile(f)) testSeen = true;
					if (factWroteImplFile(f) && !testSeen) return true;
				}
				return false;
			}
			case 'none':
				return true;
			default:
				return false;
		}
	};
}
