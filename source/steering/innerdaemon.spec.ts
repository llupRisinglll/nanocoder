import test from 'ava';
import {
	buildInnerDaemonPrompt,
	innerdaemonResponseToAction,
	parseInnerDaemonResponse,
	renderRecentTurns,
} from './innerdaemon';
import type {InnerDaemonRequest, TurnFact} from './types';

console.log('\nsteering/innerdaemon.spec.ts');

const makeFact = (overrides: Partial<TurnFact> = {}): TurnFact => ({
	turnIndex: 0,
	wallClockMs: 0,
	toolCalls: [],
	toolResults: [],
	intentClass: 'unknown',
	hadError: false,
	...overrides,
});

// --- parseInnerDaemonResponse ------------------------------------------------

test('parseInnerDaemonResponse: noop block', t => {
	const res = parseInnerDaemonResponse('ACTION: noop\nREASON: already correcting');
	t.deepEqual(res, {action: 'noop', reason: 'already correcting'});
});

test('parseInnerDaemonResponse: inject block with urgency', t => {
	const res = parseInnerDaemonResponse(
		'ACTION: inject\nMESSAGE: Use the scripts.\nURGENCY: firm',
	);
	t.deepEqual(res, {
		action: 'inject',
		message: 'Use the scripts.',
		urgency: 'firm',
	});
});

test('parseInnerDaemonResponse: inject defaults urgency to light', t => {
	const res = parseInnerDaemonResponse('ACTION: inject\nMESSAGE: nudge');
	t.deepEqual(res, {action: 'inject', message: 'nudge', urgency: 'light'});
});

test('parseInnerDaemonResponse: block block', t => {
	const res = parseInnerDaemonResponse(
		'ACTION: block\nMESSAGE: git history forbidden',
	);
	t.deepEqual(res, {action: 'block', message: 'git history forbidden'});
});

test('parseInnerDaemonResponse: stop block', t => {
	const res = parseInnerDaemonResponse('ACTION: stop\nREASON: budget exhausted');
	t.deepEqual(res, {action: 'stop', reason: 'budget exhausted'});
});

test('parseInnerDaemonResponse: strips markdown fences', t => {
	const res = parseInnerDaemonResponse(
		'```\nACTION: noop\nREASON: ok\n```',
	);
	t.deepEqual(res, {action: 'noop', reason: 'ok'});
});

test('parseInnerDaemonResponse: malformed (no ACTION) → null', t => {
	t.is(parseInnerDaemonResponse('I think the agent is fine'), null);
});

test('parseInnerDaemonResponse: inject without MESSAGE → null', t => {
	t.is(parseInnerDaemonResponse('ACTION: inject'), null);
});

test('parseInnerDaemonResponse: unknown action → null', t => {
	t.is(parseInnerDaemonResponse('ACTION: escalate\nREASON: x'), null);
});

// --- innerdaemonResponseToAction --------------------------------------------

test('innerdaemonResponseToAction: noop', t => {
	t.deepEqual(innerdaemonResponseToAction({action: 'noop', reason: 'r'}), {
		type: 'noop',
		reason: 'r',
	});
});

test('innerdaemonResponseToAction: inject', t => {
	t.deepEqual(
		innerdaemonResponseToAction({
			action: 'inject',
			message: 'm',
			urgency: 'firm',
		}),
		{type: 'inject', message: 'm', urgency: 'firm'},
	);
});

test('innerdaemonResponseToAction: block', t => {
	t.deepEqual(
		innerdaemonResponseToAction({action: 'block', message: 'm'}),
		{type: 'block', message: 'm'},
	);
});

test('innerdaemonResponseToAction: stop', t => {
	t.deepEqual(
		innerdaemonResponseToAction({action: 'stop', reason: 'r'}),
		{type: 'stop', reason: 'r'},
	);
});

// --- renderRecentTurns / buildInnerDaemonPrompt -----------------------------

test('renderRecentTurns: empty → placeholder', t => {
	t.is(renderRecentTurns([]), '(no prior turns)');
});

test('renderRecentTurns: summarizes intent + tools + errors', t => {
	const facts = [
		makeFact({
			turnIndex: 0,
			intentClass: 'runtime-setup',
			toolCalls: [
				{id: 'a', function: {name: 'execute_bash', arguments: {command: 'npm run dev'}}},
			],
		}),
		makeFact({
			turnIndex: 1,
			intentClass: 'runtime-setup',
			hadError: true,
			errorMessageDigest: 'concurrently not found',
			toolCalls: [
				{id: 'b', function: {name: 'execute_bash', arguments: {command: 'concurrently -n ui,api'}}},
			],
		}),
	];
	const out = renderRecentTurns(facts);
	t.true(out.includes('turn 0'));
	t.true(out.includes('turn 1'));
	t.true(out.includes('runtime-setup'));
	t.true(out.includes('npm run dev'));
	t.true(out.includes('ERROR'));
	t.true(out.includes('concurrently not found'));
});

test('buildInnerDaemonPrompt: includes rule body + situation', t => {
	const req: InnerDaemonRequest = {
		ruleId: 'test-rule',
		ruleBody: 'Use the scripts. Do not hand-roll.',
		situation: {
			modelId: 'mimo-v2.5',
			intentClass: 'worktree-creation',
			triggerReason: '4 turns in worktree-creation, dir not created',
			successCriterion: 'worktreeDirExists',
			criterionMet: false,
			recentTurns: [makeFact({turnIndex: 0, intentClass: 'worktree-creation'})],
		},
	};
	const prompt = buildInnerDaemonPrompt(req);
	t.true(prompt.includes('test-rule'));
	t.true(prompt.includes('Use the scripts.'));
	t.true(prompt.includes('mimo-v2.5'));
	t.true(prompt.includes('worktree-creation'));
	t.true(prompt.includes('NOT YET MET'));
	t.true(prompt.includes('turn 0'));
});

test('buildInnerDaemonPrompt: criterion met → nudges noop', t => {
	const req: InnerDaemonRequest = {
		ruleId: 'r',
		ruleBody: 'x',
		situation: {
			modelId: 'm',
			intentClass: 'worktree-creation',
			triggerReason: 'flagged',
			successCriterion: 'worktreeDirExists',
			criterionMet: true,
			recentTurns: [],
		},
	};
	t.true(buildInnerDaemonPrompt(req).includes('MET (probably a false alarm'));
});
