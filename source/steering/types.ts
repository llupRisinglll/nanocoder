/**
 * Auto-Steering + InnerDaemon type definitions.
 *
 * The steering layer sits between the passive instruction layer (skills,
 * commands, AGENTS.md) and the model. A deterministic {@link Detector}
 * evaluates the current turn against {@link SteeringRule}s every turn
 * boundary; when a rule's condition matches it either acts directly
 * (`mode: 'detector-only'`) or spins up InnerDaemon (`mode: 'innerdaemon'`) —
 * a read-only secondary thinker that decides whether and how to steer.
 *
 * See `docs/auto-steering-architecture.md` for the full design.
 */

import type {ToolCall, ToolResult} from '@/types/core';

/**
 * Coarse intent class for the current turn, derived deterministically from the
 * tool calls (see {@link classifyIntent}). Used by rule conditions
 * (`condition.intentClass`) and by budget triggers
 * (`watch.maxTurnsWithoutSuccess`).
 *
 * Keep this set small and observable — each class should map to an
 * observable success criterion so budget triggers can detect "stuck on the
 * same goal without progress".
 */
export type IntentClass =
	| 'worktree-creation'
	| 'runtime-setup'
	| 'tdd'
	| 'reproduce'
	| 'frontend-edit'
	| 'git-history'
	// Scenario-announce intents (AGENTS.md → on-demand steering migration).
	| 'gitopolis'
	| 'commit'
	| 'pr-create'
	| 'prod-ops'
	| 'ci'
	| 'branch-release'
	| 'migration-sql'
	| 'timezone-date'
	| 'pluginlib'
	| 'playwright-ui'
	| 'issue-create'
	| 'security-sensitive'
	| 'verify'
	| 'unknown';

/**
 * A flattened, serializable record of one conversation turn, accumulated by the
 * conversation loop and consumed by the detector. Pure data — cheap to thread
 * through recursion and to fabricate in tests.
 */
export interface TurnFact {
	/** Zero-based index of this turn within the current conversation loop. */
	turnIndex: number;
	/** Wall-clock milliseconds since the conversation loop started. */
	wallClockMs: number;
	/** The tool calls the model emitted this turn (empty for a pure-text turn). */
	toolCalls: ToolCall[];
	/** The results of those tool calls (paired by `tool_call_id`). */
	toolResults: ToolResult[];
	/** Deterministic intent classification of {@link toolCalls}. */
	intentClass: IntentClass;
	/** Current working directory observed for the turn (for `cwdIn` conditions). */
	cwd?: string;
	/** Whether any tool result this turn was an error. */
	hadError: boolean;
	/** First-line digest of the error content, when {@link hadError}. */
	errorMessageDigest?: string;
	/**
	 * Slash command the user invoked at the start of this loop, if any
	 * (e.g. `'worktree'`). Set by the command-integration path; used by
	 * `condition.userTriggeredSkill`.
	 */
	userTriggeredSkill?: string;
}

/**
 * Glob-style model specifier semantics: entries may be exact model ids
 * (`'mimo-v2.5'`) or trailing globs (`'*-mini'`, `'gemini-*'`).
 */
export type ModelGlob = string;

/**
 * Condition under which a steering rule becomes a *candidate* for firing.
 *
 * A rule with no condition is always a candidate (applies to all models and
 * situations) — the "cases we need to apply to all".
 *
 * `anyOf` matches if ANY contained condition matches (OR). A bare condition
 * field (top-level `modelIn`, `intentClass`, etc.) is implicitly AND-ed. To
 * express "model is mimo AND (intent is worktree OR user triggered worktree)",
 * use `anyOf` for the parenthesized part and top-level fields for the AND.
 */
export interface SteeringCondition {
	/** Model id must match one of these globs (allowlist). */
	modelIn?: ModelGlob[];
	/** Model id must NOT match any of these globs (denylist). */
	modelNotIn?: ModelGlob[];
	/** Turn intent class must equal this. */
	intentClass?: IntentClass;
	/** The user invoked this slash command / skill at loop start. */
	userTriggeredSkill?: string;
	/** A tool edited a path matching this glob (e.g. `'ui/**'`). */
	pathMatches?: string;
	/** Current working directory must match this glob. */
	cwdIn?: ModelGlob[];
	/**
	 * OR-group: matches if any contained condition matches. Other fields on the
	 * same object are AND-ed with the `anyOf` match.
	 */
	anyOf?: SteeringCondition[];
}

/**
 * A substring/regex constraint on a tool call's arguments. When the named tool
 * is invoked with arguments whose serialized form contains any of
 * {@link argMatches}, the constraint is violated → the detector-only
 * {@link SteeringRuleWatch.alsoBlock} action fires instantly (no InnerDaemon call).
 */
export interface SteeringToolConstraint {
	tool: string;
	argMatches: string[];
	/** Message shown when the constraint blocks the call. */
	message: string;
}

/**
 * What the detector watches for after a rule's condition matches. The rule
 * becomes an *active* candidate (worth firing) only when the watched budget is
 * exhausted without the success criterion being met.
 */
export interface SteeringRuleWatch {
	/**
	 * Observable success criterion for this rule's goal. The detector checks it
	 * at the turn boundary. When met, the rule stops firing.
	 *
	 * v1 supports a small set of observable predicates (see
	 * `SuccessCriterionChecker`); file/process watchers are Phase 3.
	 */
	successCriterion?: SuccessCriterion;
	/** Max consecutive turns in-scope without the criterion being met. */
	maxTurnsWithoutSuccess?: number;
	/**
	 * Time/effort-aware budget (finding #9): max WALL-CLOCK milliseconds elapsed
	 * across the SAME consecutive in-scope window ({@link maxTurnsWithoutSuccess}
	 * measures) without the criterion being met. The rule becomes a candidate
	 * when EITHER the turn budget is exhausted OR — if this is set — the elapsed
	 * in-scope wall-clock (latest `TurnFact.wallClockMs` − the window's first
	 * `wallClockMs`) reaches this. Catches the slow-spiral case (few turns, many
	 * minutes) that a pure turn count misses. A met success criterion resets this
	 * window exactly as it resets the turn counter (they share one reset). When
	 * unset, budget behavior is byte-identical to the turn-count-only path.
	 *
	 * Evaluated at the TURN BOUNDARY (retroactive — "the last window took too
	 * long"); true within-turn interruption is deferred (see the code comment in
	 * `detector.ts` and finding #9 in `docs/innerdaemon-steering-findings.md`).
	 */
	maxWallClockMsWithoutSuccess?: number;
	/** Hard constraints that fire instantly (detector-only, no budget). */
	alsoBlock?: SteeringToolConstraint[];
	/**
	 * Windowed repeat-detection trigger (finding runtime-setup-loop): make the
	 * rule a candidate once the LATEST turn's tool call has been issued,
	 * verbatim (after whitespace-normalization), in at least this many turns of
	 * the recent {@link TurnFact} window. Fires SOONER than the turn-budget for
	 * the precise "re-issuing the SAME probe" spin (e.g. `lsof -i :4161` run
	 * N times). Evaluated in `detector.ts` alongside — not instead of — the
	 * budget gate; when the rule's `successCriterion` is already met the repeat
	 * trigger is suppressed (a confirming probe of a live port is fine).
	 */
	repeatThreshold?: number;
	/**
	 * Optional scope for {@link repeatThreshold}: only tool calls whose
	 * normalized `name + args` blob contains one of these substrings are counted
	 * as repeats (e.g. `['lsof', 'ss ', 'curl', 'netstat']` to restrict the
	 * signal to read-only port probes, so a legitimately repeated
	 * build/restore step that DOES change state isn't misflagged). When omitted
	 * or empty, every tool call is eligible.
	 */
	repeatToolMatches?: string[];
}

/**
 * Built-in observable success criteria. Each maps to a cheap, deterministic
 * check the detector can run at the turn boundary (no LLM, no heavy I/O).
 */
export type SuccessCriterion =
	| 'worktreeDirExists'
	| 'portListenerExists'
	| 'newTestFileExists'
	/**
	 * Loop-stateful (reproduction-first): met once the loop has, in ANY turn,
	 * either called a `browser_*` tool OR run the app / dev server without
	 * error. Stays met through the subsequent fix phase.
	 */
	| 'uiDrivenOrAppRun'
	/**
	 * Loop-stateful (over-exploration budget): met once ANY concrete artifact
	 * has been produced in the task — a `write_file`/`string_replace`, a
	 * `browser_*` call, or a test run. The generic "you have explored enough,
	 * produce something" signal behind findings #7/#8.
	 */
	| 'artifactProducedThisTask'
	/**
	 * Loop-stateful ANTI-criterion (tdd-discipline): true once, in this task, an
	 * implementation (non-`.spec`/`.test`) source file was written BEFORE any
	 * test file was written. Unlike the others this is a VIOLATION signal, not a
	 * goal — see the checker comment for how a rule consumes it.
	 */
	| 'implEditedBeforeTest'
	| 'none';

/** Whether a rule acts deterministically or delegates judgment to InnerDaemon. */
export type SteeringMode = 'detector-only' | 'innerdaemon' | 'announce';

/**
 * A steering rule, parsed from `.nanocoder/steering/*.steer.md` frontmatter.
 * The file body (below the frontmatter) is InnerDaemon's domain context —
 * loaded into InnerDaemon's prompt only when this rule fires, never into the
 * main agent's always-on context.
 */
export interface SteeringRule {
	id: string;
	description?: string;
	condition?: SteeringCondition;
	watch?: SteeringRuleWatch;
	mode: SteeringMode;
	/**
	 * After this many InnerDaemon injections with no forward progress, escalate
	 * `inject → stop`. Defaults to {@link DEFAULT_STEERING_MAX_FIRES}.
	 */
	maxFires?: number;
	/** Don't re-fire for this many turns after firing. Defaults to constant. */
	cooldownTurns?: number;
	/** InnerDaemon domain context (the migrated dense prose). */
	body?: string;
	/**
	 * `announce`-mode only: the name of a sibling slash-command skill
	 * (`.nanocoder/commands/<name>.md`) whose body is loaded (frontmatter
	 * stripped) at parse time and used as the announce message. Lets a scenario
	 * inject a skill's own guidance on-demand — the skill stays the single
	 * source of truth — instead of duplicating it in `body`. Mutually exclusive
	 * with a literal `body`; when set, the loader has already inlined the skill
	 * body into `body`.
	 */
	injectSkill?: string;
	/** Where the rule was loaded from (for diagnostics). */
	source?: string;
}

/**
 * A rule that matched the current turn's facts, ready for the engine to act on
 * (detector-only) or hand to InnerDaemon.
 */
export interface SteeringCandidate {
	rule: SteeringRule;
	/** Human-readable reason the detector matched (for InnerDaemon/logging). */
	reason: string;
	/** The turn index at which the match occurred. */
	turnIndex: number;
}

/**
 * Urgency of an injected steering nudge, controlling visual weight in the TUI.
 * - `light` (default): grey `colors.secondary` "light detail" (the norm).
 * - `firm`: still inline but with a `colors.warning` glyph accent.
 * Loud `ErrorMessage` boxes are reserved for hard `stop` actions only.
 */
export type SteeringUrgency = 'light' | 'firm';

/**
 * Action emitted by the steering engine, applied at the conversation-loop
 * recursion seam. `null`/undefined means "no steering this turn".
 */
export type SteeringAction =
	| {type: 'noop'; reason: string}
	| {
			type: 'inject';
			message: string;
			urgency?: SteeringUrgency;
			/** Steering rule that produced this action, for the trace header. */
			ruleId?: string;
			/** Effective InnerDaemon model, shown on the `◆ InnerDaemon` header. */
			model?: string;
	  }
	| {
			type: 'block';
			/** Tool call ids to cancel (paired with cancellation results). */
			toolCallIds?: string[];
			message: string;
			urgency?: SteeringUrgency;
			/** Steering rule that produced this action, for the trace header. */
			ruleId?: string;
			/** Effective InnerDaemon model, shown on the `◆ InnerDaemon` header. */
			model?: string;
	  }
	| {type: 'stop'; reason: string};

/**
 * Request handed to InnerDaemon (the secondary thinker). Built by the engine from
 * a {@link SteeringCandidate} + recent turn history.
 */
export interface InnerDaemonRequest {
	ruleId: string;
	/** InnerDaemon domain context (the rule body — the migrated dense prose). */
	ruleBody: string;
	situation: {
		modelId: string;
		intentClass: IntentClass;
		recentTurns: TurnFact[];
		/** Why the detector fired (human-readable). */
		triggerReason: string;
		/** The observable goal, if the rule declares one. */
		successCriterion?: SuccessCriterion;
		/** Result of checking the criterion this turn. */
		criterionMet?: boolean;
		/**
		 * ANTI-criterion ordering signal (tdd-discipline, finding #8): true when,
		 * in THIS task, an implementation (non-`.spec`/`.test`) source file was
		 * written BEFORE any test file. Computed INDEPENDENTLY of the rule's own
		 * {@link successCriterion} (so a rule watching `newTestFileExists` can still
		 * observe the ordering violation) and surfaced in the InnerDaemon prompt.
		 * Unlike {@link criterionMet} (a positive goal), `true` here is a VIOLATION
		 * the daemon reads to decide a test-first nudge; absent/false = no violation.
		 */
		implEditedBeforeTest?: boolean;
		/**
		 * Relapse-escalation level (finding #9), derived from how many times this
		 * rule has ALREADY fired without the criterion being met: 0 = first nudge,
		 * 1 = firmer re-nudge, ≥2 = persistent relapse. InnerDaemon reads this to
		 * raise its own message firmness; the engine also uses it at the top level
		 * to upgrade a repeated `inject` toward `block`/`stop`. Absent/0 means a
		 * first fire — behave exactly as before.
		 */
		escalationLevel?: number;
	};
}

/**
 * InnerDaemon's decision. Strict schema — the system prompt forces this shape.
 * On any parse failure the engine falls back to `noop` (fail-safe: never steer
 * on a malformed InnerDaemon reply).
 */
export type InnerDaemonResponse =
	| {action: 'noop'; reason: string}
	| {action: 'inject'; message: string; urgency?: SteeringUrgency}
	| {action: 'block'; message: string}
	| {action: 'stop'; reason: string};

/**
 * Cheap, allocation-light description of a single steering evaluation, produced
 * ONLY when the verbose "proof-of-life" mode is enabled. It reflects the SAME
 * evaluation that drives real steering: the {@link decision} is the actual
 * action the engine chose this turn, and {@link inScopeRuleId}/{@link budgetUsed}
 * come from the same condition/budget primitives the detector uses — never a
 * second, divergent detection pass. Used by the conversation loop to emit a
 * one-line dim trace so a quiet (noop) turn is visibly alive.
 */
export interface SteeringDiagnostic {
	/** Deterministic intent classification of the latest turn's tool calls. */
	intentClass: IntentClass;
	/** First rule whose condition matched the latest turn, or null if none. */
	inScopeRuleId: string | null;
	/** Consecutive in-scope turns accumulated for the in-scope rule (0 if none). */
	budgetUsed: number;
	/** The in-scope rule's `maxTurnsWithoutSuccess` budget (0 if no rule/watch). */
	budgetMax: number;
	/** The action the engine actually chose this turn. */
	decision: 'noop' | 'nudge' | 'block' | 'stop';
	/**
	 * The model the InnerDaemon secondary thinker would run on for the in-scope
	 * rule — set ONLY when that rule is `innerdaemon` mode (the LLM-thinker,
	 * lag-causing path). Deterministic `announce`/`detector-only` rules use no
	 * model, so this stays undefined for them. Surfaces which model is active so
	 * a customized InnerDaemon model is visible in the trace.
	 */
	innerDaemonModel?: string;
}

/** Per-rule fire/cooldown state held by the steering engine. */
export interface RuleFireState {
	/** How many times this rule has fired (across cooldown windows). */
	fires: number;
	/** Turn index of the last fire, or -1 if never. */
	lastFireTurn: number;
}
