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
			return {
				type: 'inject',
				message: this.detectorOnlyMessage(rule, candidate),
				urgency: 'light',
			};
		}

		// innerdaemon rules delegate to the secondary thinker.
		const req = this.buildRequest(rule, candidate, facts);
		const response = await this.innerdaemon(req, signal);
		const action = innerdaemonResponseToAction(response);

		// Only count a fire if InnerDaemon actually steered (noop doesn't consume
		// a fire slot — a false alarm shouldn't burn the escalation budget).
		if (action.type !== 'noop') {
			this.recordFire(rule.id, candidate.turnIndex);
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
	): InnerDaemonRequest {
		const latest = facts[facts.length - 1];
		const criterion = rule.watch?.successCriterion;
		const criterionMet =
			criterion && criterion !== 'none'
				? this.checker(criterion, latest)
				: undefined;
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

/**
 * Build a success-criterion checker bound to a worktree-root / cwd context.
 * The conversation loop passes the current cwd; v1 implements the observable
 * predicates as cheap fs/socket checks. Phase 3 swaps these for the events
 * file-watcher.
 *
 * Returned checker is safe to call repeatedly (idempotent reads).
 */
export function createCriterionChecker(
	getCwd: () => string,
): SuccessCriterionChecker {
	return (criterion, fact) => {
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
			case 'none':
				return true;
			default:
				return false;
		}
	};
}
