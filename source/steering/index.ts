/**
 * Auto-steering + InnerDaemon public surface.
 *
 * Consumers (the conversation loop, useChatHandler) import from here rather
 * than reaching into individual modules. See `docs/auto-steering-architecture.md`.
 */

export {
	conditionMatches,
	consecutiveInScopeCount,
	describeInScope,
	detectConstraintViolations,
	evaluateRules,
	modelMatchesAny,
	modelMatchesGlob,
	pathMatchesGlob,
	type SuccessCriterionChecker,
} from '@/steering/detector';
export {
	buildInnerDaemonPrompt,
	innerdaemonResponseToAction,
	invokeInnerDaemon,
	parseInnerDaemonResponse,
	renderRecentTurns,
} from '@/steering/innerdaemon';
export {
	classifyIntent,
	matchingArgSubstring,
	serializeToolArgs,
} from '@/steering/intent-classifier';
export {parseSteeringRule, SteeringRuleLoader} from '@/steering/loader';
export {
	createCriterionChecker,
	type EvaluateOptions,
	type InnerDaemonInvoker,
	SteeringEngine,
	type SteeringEngineOptions,
} from '@/steering/steering-engine';
export type {
	InnerDaemonRequest,
	InnerDaemonResponse,
	IntentClass,
	RuleFireState,
	SteeringAction,
	SteeringCandidate,
	SteeringCondition,
	SteeringDiagnostic,
	SteeringMode,
	SteeringRule,
	SteeringRuleWatch,
	SteeringToolConstraint,
	SteeringUrgency,
	SuccessCriterion,
	TurnFact,
} from '@/steering/types';

import {SteeringRuleLoader} from '@/steering/loader';
import type {SteeringEngineOptions} from '@/steering/steering-engine';
import {
	createCriterionChecker,
	SteeringEngine,
} from '@/steering/steering-engine';
import {SubagentExecutor} from '@/subagents/subagent-executor';
import type {ToolManager} from '@/tools/tool-manager';
import type {DevelopmentMode, LLMClient} from '@/types/core';

/**
 * Create the SubagentExecutor that backs InnerDaemon invocations.
 *
 * The mode resolver MUST be wired whenever the caller has a live development
 * mode: InnerDaemon's read-only verification probes (e.g. `execute_bash` port
 * checks) go through the same approval policy as any other subagent tool
 * call, and an executor without a mode source snapshots `'normal'` forever —
 * which pops a spurious execute_bash confirmation in yolo mode every time
 * InnerDaemon escalates. Genuinely destructive commands stay gated
 * independently of mode by the tool validators (see execute-bash's
 * dangerous-pattern validator).
 */
export function createInnerDaemonExecutor(
	toolManager: ToolManager,
	client: LLMClient,
	modeResolver?: () => DevelopmentMode,
): SubagentExecutor {
	const executor = new SubagentExecutor(toolManager, client);
	if (modeResolver) {
		executor.setModeResolver(modeResolver);
	}
	return executor;
}

/**
 * Factory: build a SteeringEngine from loaded rules + cwd/model context.
 * The caller binds the InnerDaemon executor separately via `engine.bindExecutor()`
 * once the SubagentExecutor is available.
 */
export function createSteeringEngine(
	opts: Pick<SteeringEngineOptions, 'rules' | 'modelId'> & {
		getCwd: () => string;
	},
): SteeringEngine {
	return new SteeringEngine({
		rules: opts.rules,
		modelId: opts.modelId,
		criterionChecker: createCriterionChecker(opts.getCwd),
	});
}

/** Convenience: load rules + build an engine in one call. */
export function loadAndCreateSteeringEngine(
	projectRoot: string,
	modelId: string,
	getCwd: () => string,
): SteeringEngine {
	const loader = new SteeringRuleLoader(projectRoot);
	const rules = loader.loadRules();
	return createSteeringEngine({rules, modelId, getCwd});
}
