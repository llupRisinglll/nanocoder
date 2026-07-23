import test from 'ava';
import type {ToolCall} from '@/types/core';
import {buildInnerDaemonPrompt} from './innerdaemon';
import {
	createCriterionChecker,
	SteeringEngine,
	type InnerDaemonInvoker,
} from './steering-engine';
import type {InnerDaemonRequest, SteeringRule, TurnFact} from './types';

console.log('\nsteering/tdd-signal.spec.ts');

// Regression coverage for the tdd-discipline firing path (finding #8): the
// engine must surface the loop-stateful `implEditedBeforeTest` ANTI-criterion
// into the InnerDaemon request/prompt INDEPENDENTLY of the rule's own
// successCriterion (`newTestFileExists`). Pre-glue, situation had no such field
// and the prompt never mentioned the ordering violation — so these fail without
// the buildRequest + buildInnerDaemonPrompt changes.

const toolCall = (
	id: string,
	name: string,
	args: Record<string, unknown> = {},
): ToolCall => ({id, function: {name, arguments: args}});

const makeFact = (overrides: Partial<TurnFact> = {}): TurnFact => ({
	turnIndex: 0,
	wallClockMs: 0,
	toolCalls: [],
	toolResults: [],
	intentClass: 'unknown',
	hadError: false,
	...overrides,
});

const MIMO = 'mimo-v2.5';

const tddRule: SteeringRule = {
	id: 'tdd-discipline',
	mode: 'innerdaemon',
	maxFires: 2,
	cooldownTurns: 1,
	condition: {modelIn: [MIMO], intentClass: 'tdd'},
	watch: {successCriterion: 'newTestFileExists', maxTurnsWithoutSuccess: 1},
	body: 'Write the failing test first.',
};

/** Run the engine over `facts`, capturing the InnerDaemon request built. */
async function captureRequest(
	facts: TurnFact[],
): Promise<InnerDaemonRequest | null> {
	let captured: InnerDaemonRequest | null = null;
	const invoker: InnerDaemonInvoker = async req => {
		captured = req;
		return {action: 'noop', reason: 'test'};
	};
	const engine = new SteeringEngine({
		rules: [tddRule],
		modelId: MIMO,
		criterionChecker: createCriterionChecker(() => '/mnt/x/Hilinga'),
		innerdaemon: invoker,
	});
	await engine.evaluate(facts);
	return captured;
}

test('buildRequest surfaces implEditedBeforeTest=TRUE when impl edited with no test', async t => {
	const facts = [
		makeFact({
			turnIndex: 0,
			intentClass: 'tdd',
			toolCalls: [
				toolCall('a', 'string_replace', {path: 'source/counter.ts'}),
			],
		}),
	];
	const req = await captureRequest(facts);
	t.truthy(req);
	t.is(req?.situation.implEditedBeforeTest, true);
});

test('buildRequest surfaces implEditedBeforeTest=FALSE when the test was written first', async t => {
	const facts = [
		makeFact({
			turnIndex: 0,
			intentClass: 'tdd',
			toolCalls: [
				toolCall('t', 'write_file', {path: 'source/counter.spec.ts'}),
			],
		}),
		makeFact({
			turnIndex: 1,
			intentClass: 'tdd',
			toolCalls: [
				toolCall('i', 'string_replace', {path: 'source/counter.ts'}),
			],
		}),
	];
	const req = await captureRequest(facts);
	t.truthy(req);
	t.is(req?.situation.implEditedBeforeTest, false);
});

test('buildInnerDaemonPrompt renders the ordering line only when implEditedBeforeTest is true', t => {
	const base: InnerDaemonRequest = {
		ruleId: 'tdd-discipline',
		ruleBody: 'body',
		situation: {
			modelId: MIMO,
			intentClass: 'tdd',
			recentTurns: [],
			triggerReason: 'test',
			successCriterion: 'newTestFileExists',
			criterionMet: false,
		},
	};
	const withViolation = buildInnerDaemonPrompt({
		...base,
		situation: {...base.situation, implEditedBeforeTest: true},
	});
	t.true(withViolation.includes('implEditedBeforeTest = TRUE'));

	const withoutViolation = buildInnerDaemonPrompt({
		...base,
		situation: {...base.situation, implEditedBeforeTest: false},
	});
	t.false(withoutViolation.includes('implEditedBeforeTest = TRUE'));
});
