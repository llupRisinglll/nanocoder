import test from 'ava';
import {formatSteeringTrace} from '@/components/innerdaemon-trace';
import {SteeringEngine, type InnerDaemonInvoker} from './steering-engine';
import type {
	InnerDaemonResponse,
	SteeringDiagnostic,
	SteeringRule,
	TurnFact,
} from './types';
import type {ToolCall, ToolResult} from '@/types/core';

console.log('\nsteering/steering-verbose.spec.ts');

// --- fixtures --------------------------------------------------------------

const toolCall = (id: string, name: string): ToolCall => ({
	id,
	function: {name, arguments: {}},
});
const toolResult = (toolCallId: string, name: string): ToolResult => ({
	tool_call_id: toolCallId,
	role: 'tool',
	name,
	content: 'created',
});

const MIMO = 'mimo-v2.5';

const worktreeRule: SteeringRule = {
	id: 'hilinga-worktree-supervision',
	mode: 'innerdaemon',
	maxFires: 3,
	cooldownTurns: 1,
	condition: {modelIn: [MIMO], intentClass: 'worktree-creation'},
	watch: {successCriterion: 'worktreeDirExists', maxTurnsWithoutSuccess: 4},
	body: 'Use the scripts.',
};

const worktreeFact = (turnIndex: number): TurnFact => ({
	turnIndex,
	wallClockMs: 0,
	intentClass: 'worktree-creation',
	toolCalls: [toolCall(`a${turnIndex}`, 'execute_bash')],
	toolResults: [toolResult(`a${turnIndex}`, 'execute_bash')],
	hadError: false,
});

const runtimeFact = (turnIndex: number): TurnFact => ({
	turnIndex,
	wallClockMs: 0,
	intentClass: 'runtime-setup',
	toolCalls: [toolCall(`b${turnIndex}`, 'execute_bash')],
	toolResults: [toolResult(`b${turnIndex}`, 'execute_bash')],
	hadError: false,
});

const neverMet = () => false;

const engineWith = (
	rules: SteeringRule[],
	response: InnerDaemonResponse,
): SteeringEngine =>
	new SteeringEngine({
		rules,
		modelId: MIMO,
		criterionChecker: neverMet,
		innerdaemon: (async () => response) as InnerDaemonInvoker,
	});

// --- verbose diagnostics: the SAME evaluation that drives steering ----------

test('verbose: noop turn (below budget) still emits a diagnostic naming the in-scope rule + budget', async t => {
	const engine = engineWith([worktreeRule], {action: 'noop', reason: ''});
	// One in-scope turn, budget is 4 → not exhausted → the real decision is noop
	// (evaluate returns null, no InnerDaemon steering).
	const facts = [worktreeFact(0)];

	let diagnostic: SteeringDiagnostic | null = null;
	const action = await engine.evaluate(facts, undefined, {
		onDiagnostic: d => {
			diagnostic = d;
		},
	});

	t.is(action, null, 'below-budget turn steers nothing');
	t.deepEqual(diagnostic, {
		intentClass: 'worktree-creation',
		inScopeRuleId: 'hilinga-worktree-supervision',
		budgetUsed: 1,
		budgetMax: 4,
		decision: 'noop',
	} satisfies SteeringDiagnostic);
});

test('verbose gate: no diagnostic is produced unless onDiagnostic is supplied', async t => {
	const engine = engineWith([worktreeRule], {action: 'noop', reason: ''});
	const facts = [worktreeFact(0)];

	let calls = 0;
	// Off (no opts) → silent.
	await engine.evaluate(facts);
	t.is(calls, 0, 'no diagnostic when verbose is off');

	// On → exactly one diagnostic for the evaluation.
	await engine.evaluate(facts, undefined, {
		onDiagnostic: () => {
			calls++;
		},
	});
	t.is(calls, 1, 'exactly one diagnostic when verbose is on');
});

test('verbose: a real nudge reports decision=nudge for the same evaluation', async t => {
	const engine = engineWith([worktreeRule], {
		action: 'inject',
		message: 'Use the worktree script.',
		urgency: 'light',
	});
	// Budget is 4 → need 4 consecutive in-scope turns to exhaust it.
	const facts = [
		worktreeFact(0),
		worktreeFact(1),
		worktreeFact(2),
		worktreeFact(3),
	];

	let diagnostic: SteeringDiagnostic | null = null;
	const action = await engine.evaluate(facts, undefined, {
		onDiagnostic: d => {
			diagnostic = d;
		},
	});

	t.is(action?.type, 'inject', 'budget exhausted → InnerDaemon nudges');
	t.truthy(diagnostic);
	t.is(diagnostic!.decision, 'nudge');
	t.is(diagnostic!.inScopeRuleId, 'hilinga-worktree-supervision');
	t.is(diagnostic!.budgetUsed, 4);
	t.is(diagnostic!.budgetMax, 4);
});

test('verbose: an out-of-scope intent reports no rule in scope', async t => {
	const engine = engineWith([worktreeRule], {action: 'noop', reason: ''});
	const facts = [runtimeFact(0)];

	let diagnostic: SteeringDiagnostic | null = null;
	await engine.evaluate(facts, undefined, {
		onDiagnostic: d => {
			diagnostic = d;
		},
	});

	t.deepEqual(diagnostic, {
		intentClass: 'runtime-setup',
		inScopeRuleId: null,
		budgetUsed: 0,
		budgetMax: 0,
		decision: 'noop',
	} satisfies SteeringDiagnostic);
});

// --- trace formatting ------------------------------------------------------

test('formatSteeringTrace: in-scope noop line', t => {
	t.is(
		formatSteeringTrace({
			intentClass: 'worktree-creation',
			inScopeRuleId: 'hilinga-worktree-supervision',
			budgetUsed: 2,
			budgetMax: 4,
			decision: 'noop',
		}),
		'InnerDaemon · intent=worktree-creation · rule=hilinga-worktree-supervision · budget 2/4 · noop',
	);
});

test('formatSteeringTrace: no rule in scope line', t => {
	t.is(
		formatSteeringTrace({
			intentClass: 'runtime-setup',
			inScopeRuleId: null,
			budgetUsed: 0,
			budgetMax: 0,
			decision: 'noop',
		}),
		'InnerDaemon · intent=runtime-setup · no rule in scope · noop',
	);
});
