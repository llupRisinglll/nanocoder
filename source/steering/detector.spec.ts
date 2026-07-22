import test from 'ava';
import type {ToolCall, ToolResult} from '@/types/core';
import {
	conditionMatches,
	detectConstraintViolations,
	evaluateRules,
	modelMatchesGlob,
	pathMatchesGlob,
} from './detector';
import {
	classifyIntent,
	matchingArgSubstring,
	serializeToolArgs,
} from './intent-classifier';
import type {
	SteeringCondition,
	SteeringRule,
	TurnFact,
} from './types';

console.log('\nsteering/detector.spec.ts');

// --- fixtures -------------------------------------------------------------

const toolCall = (
	id: string,
	name: string,
	args: Record<string, unknown> | string = {},
): ToolCall => ({
	id,
	function: {name, arguments: args as ToolCall['function']['arguments']},
});

const toolResult = (
	toolCallId: string,
	name: string,
	content = 'ok',
): ToolResult => ({tool_call_id: toolCallId, role: 'tool', name, content});

const makeFact = (overrides: Partial<TurnFact> = {}): TurnFact => ({
	turnIndex: 0,
	wallClockMs: 0,
	toolCalls: [],
	toolResults: [],
	intentClass: 'unknown',
	hadError: false,
	...overrides,
});

// a fact where the model ran a hand-rolled worktree command
const worktreeHandRollFact = (turnIndex: number): TurnFact =>
	makeFact({
		turnIndex,
		toolCalls: [
			toolCall('a', 'execute_bash', {
				command: 'git worktree add .claude/worktrees/x kplugin_counter',
			}),
		],
		toolResults: [toolResult('a', 'execute_bash')],
		intentClass: classifyIntent([
			toolCall('a', 'execute_bash', {command: 'git worktree add x'}),
		]),
	});

const alwaysTrueChecker = () => true;
const alwaysFalseChecker = () => false;

const MIMO = 'mimo-v2.5';
const CLAUDE = 'claude-sonnet-4-6';

// --- model glob -----------------------------------------------------------

test('modelMatchesGlob: exact id', t => {
	t.true(modelMatchesGlob('mimo-v2.5', 'mimo-v2.5'));
	t.false(modelMatchesGlob('mimo-v2.5', 'mimo-v2.6'));
});

test('modelMatchesGlob: trailing wildcard', t => {
	t.true(modelMatchesGlob('gpt-4o-mini', '*-mini'));
	t.true(modelMatchesGlob('gemini-2.5-flash', 'gemini-*'));
	t.false(modelMatchesGlob('claude-sonnet-4-6', '*-mini'));
});

test('modelMatchesGlob: contains wildcard', t => {
	t.true(modelMatchesGlob('gpt-4o-mini-2024', '*mini*'));
});

// --- path glob ------------------------------------------------------------

test('pathMatchesGlob: ** matches across dirs', t => {
	t.true(pathMatchesGlob('ui/**', 'ui/remote/lib/chains.ts'));
	t.true(pathMatchesGlob('ui/**', 'ui/index.tsx'));
	t.false(pathMatchesGlob('ui/**', 'server/routes/x.ts'));
});

test('pathMatchesGlob: single * does not cross /', t => {
	t.true(pathMatchesGlob('ui/*.tsx', 'ui/App.tsx'));
	t.false(pathMatchesGlob('ui/*.tsx', 'ui/remote/App.tsx'));
});

// --- intent classifier ----------------------------------------------------

test('classifyIntent: git log is git-history (highest priority)', t => {
	const tc = [toolCall('a', 'execute_bash', {command: 'git log -1 main'})];
	t.is(classifyIntent(tc), 'git-history');
});

test('classifyIntent: git worktree add is worktree-creation', t => {
	const tc = [
		toolCall('a', 'execute_bash', {command: 'git worktree add --track foo'}),
	];
	t.is(classifyIntent(tc), 'worktree-creation');
});

test('classifyIntent: mkdir of a worktrees path (hand-roll) is worktree-creation', t => {
	const tc = [
		toolCall('a', 'execute_bash', {
			command: 'mkdir -p .claude/worktrees/nanocoder-counter-auto-settle',
		}),
	];
	t.is(classifyIntent(tc), 'worktree-creation');
});

test('classifyIntent: ls of an existing worktrees path is NOT worktree-creation (finding #5)', t => {
	// A bare read over an existing worktree path used to mis-classify as
	// worktree-creation (path was a keyword), keeping the rule in scope during
	// the reproduce/TDD/fix phases.
	const tc = [
		toolCall('a', 'execute_bash', {
			command: 'ls .claude/worktrees/nanocoder-counter-auto-settle/',
		}),
	];
	t.not(classifyIntent(tc), 'worktree-creation');
	t.is(classifyIntent(tc), 'unknown');
});

test('classifyIntent: worktree-create.sh is worktree-creation (standalone op keyword)', t => {
	const tc = [
		toolCall('a', 'execute_bash', {
			command: './worktree-create.sh nanocoder-counter-auto-settle',
		}),
	];
	t.is(classifyIntent(tc), 'worktree-creation');
});

test('classifyIntent: npm run dev is runtime-setup', t => {
	const tc = [toolCall('a', 'execute_bash', {command: 'npm run dev'})];
	t.is(classifyIntent(tc), 'runtime-setup');
});

test('classifyIntent: spec file write is tdd', t => {
	const tc = [
		toolCall('a', 'write_file', {path: 'tests/unit/board-buckets.spec.ts'}),
	];
	t.is(classifyIntent(tc), 'tdd');
});

test('classifyIntent: tsx edit under ui/ is frontend-edit', t => {
	const tc = [
		toolCall('a', 'string_replace', {path: 'ui/remote/index.tsx'}),
	];
	t.is(classifyIntent(tc), 'frontend-edit');
});

test('classifyIntent: empty / pure-text turn is unknown', t => {
	t.is(classifyIntent([]), 'unknown');
});

test('classifyIntent: unrelated command is unknown', t => {
	const tc = [toolCall('a', 'execute_bash', {command: 'ls -la'})];
	t.is(classifyIntent(tc), 'unknown');
});

test('matchingArgSubstring: detects forbidden substring in bash args', t => {
	const tc = toolCall('a', 'execute_bash', {command: 'git log --oneline'});
	t.is(
		matchingArgSubstring(tc, 'execute_bash', ['git log', 'git show']),
		'git log',
	);
});

test('matchingArgSubstring: wrong tool name → null', t => {
	const tc = toolCall('a', 'read_file', {path: 'x'});
	t.is(matchingArgSubstring(tc, 'execute_bash', ['git log']), null);
});

test('serializeToolArgs: object → json string', t => {
	t.is(
		serializeToolArgs({command: 'npm run dev'}),
		'{"command":"npm run dev"}',
	);
});

// --- condition matching ---------------------------------------------------

const worktreeCondition: SteeringCondition = {
	modelIn: ['mimo-v2.5', '*-mini', '*-flash'],
	anyOf: [
		{intentClass: 'worktree-creation'},
		{userTriggeredSkill: 'worktree'},
	],
};

test('conditionMatches: mimo + worktree intent → true', t => {
	t.true(
		conditionMatches(
			worktreeCondition,
			MIMO,
			makeFact({intentClass: 'worktree-creation'}),
		),
	);
});

test('conditionMatches: mimo + userTriggeredSkill worktree → true', t => {
	t.true(
		conditionMatches(
			worktreeCondition,
			MIMO,
			makeFact({
				intentClass: 'unknown',
				userTriggeredSkill: 'worktree',
			}),
		),
	);
});

test('conditionMatches: Claude (not in modelIn) → false (model gate)', t => {
	t.false(
		conditionMatches(
			worktreeCondition,
			CLAUDE,
			makeFact({intentClass: 'worktree-creation'}),
		),
	);
});

test('conditionMatches: mimo but wrong intent and no skill → false', t => {
	t.false(
		conditionMatches(
			worktreeCondition,
			MIMO,
			makeFact({intentClass: 'runtime-setup'}),
		),
	);
});

test('conditionMatches: pathMatches gates on edited paths', t => {
	const cond: SteeringCondition = {pathMatches: 'ui/**'};
	const fact = makeFact({
		toolCalls: [toolCall('a', 'string_replace', {path: 'ui/x.tsx'})],
	});
	t.true(conditionMatches(cond, MIMO, fact));
	t.false(
		conditionMatches(
			cond,
			MIMO,
			makeFact({
				toolCalls: [
					toolCall('a', 'string_replace', {path: 'server/x.ts'}),
				],
			}),
		),
	);
});

// --- evaluateRules: the simulation scenarios ------------------------------

const worktreeRule = (maxTurns = 4): SteeringRule => ({
	id: 'hilinga-worktree-supervision',
	mode: 'innerdaemon',
	condition: worktreeCondition,
	watch: {
		successCriterion: 'worktreeDirExists',
		maxTurnsWithoutSuccess: maxTurns,
	},
});

test('evaluateRules: mimo worktree hand-roll past budget → candidate fires', t => {
	// 5 consecutive worktree-creation turns, criterion never met (checker false)
	const facts = [0, 1, 2, 3, 4].map(i => worktreeHandRollFact(i));
	const cands = evaluateRules(facts, [worktreeRule(4)], MIMO, alwaysFalseChecker);
	t.is(cands.length, 1);
	t.is(cands[0].rule.id, 'hilinga-worktree-supervision');
});

test('evaluateRules: mimo worktree but budget not yet exceeded → no candidate', t => {
	const facts = [0, 1, 2].map(i => worktreeHandRollFact(i)); // only 3 turns
	const cands = evaluateRules(facts, [worktreeRule(4)], MIMO, alwaysFalseChecker);
	t.is(cands.length, 0);
});

test('evaluateRules: Claude session on same tools → no candidate (model gate)', t => {
	const facts = [0, 1, 2, 3, 4, 5, 6, 7].map(i => worktreeHandRollFact(i));
	const cands = evaluateRules(facts, [worktreeRule(4)], CLAUDE, alwaysFalseChecker);
	t.is(cands.length, 0);
});

test('evaluateRules: criterion already met → window resets, no candidate', t => {
	// 5 worktree turns, but the criterion IS met (checker true) → never fires
	const facts = [0, 1, 2, 3, 4].map(i => worktreeHandRollFact(i));
	const cands = evaluateRules(facts, [worktreeRule(4)], MIMO, alwaysTrueChecker);
	t.is(cands.length, 0);
});

test('evaluateRules: empty facts → no candidates', t => {
	t.deepEqual(evaluateRules([], [worktreeRule()], MIMO, alwaysFalseChecker), []);
});

test('evaluateRules: rule with no condition is always a candidate (no budget)', t => {
	const universalRule: SteeringRule = {
		id: 'universal',
		mode: 'detector-only',
	};
	const facts = [makeFact({turnIndex: 0, intentClass: 'unknown'})];
	const cands = evaluateRules(facts, [universalRule], MIMO, alwaysFalseChecker);
	t.is(cands.length, 1);
});

// --- constraint violations (detector-only instant block) ------------------

const noHistoryRule: SteeringRule = {
	id: 'no-git-history',
	mode: 'detector-only',
	watch: {
		alsoBlock: [
			{
				tool: 'execute_bash',
				argMatches: ['git log', 'git show', 'git blame', 'git reflog'],
				message: 'git-history is forbidden in this simulation.',
			},
		],
	},
};

test('detectConstraintViolations: git log in bash → violation', t => {
	const facts = [
		makeFact({
			turnIndex: 0,
			toolCalls: [
				toolCall('a', 'execute_bash', {command: 'git log -1 main'}),
			],
		}),
	];
	const v = detectConstraintViolations(facts, [noHistoryRule]);
	t.truthy(v);
	t.is(v?.constraint.tool, 'execute_bash');
	t.is(v?.matched, 'git log');
});

test('detectConstraintViolations: clean turn → null', t => {
	const facts = [
		makeFact({
			turnIndex: 0,
			toolCalls: [toolCall('a', 'execute_bash', {command: 'ls'})],
		}),
	];
	t.is(detectConstraintViolations(facts, [noHistoryRule]), null);
});

test('detectConstraintViolations: git show via git_show tool name mismatch → null', t => {
	// constraint names `execute_bash`; a git_* tool wouldn't match by tool name.
	// (v1 limitation: substring on the named tool only. Acceptable — git_*
	// tools are rare and the constraint can list them explicitly.)
	const facts = [
		makeFact({
			turnIndex: 0,
			toolCalls: [toolCall('a', 'git_show', {ref: 'HEAD'})],
		}),
	];
	t.is(detectConstraintViolations(facts, [noHistoryRule]), null);
});
