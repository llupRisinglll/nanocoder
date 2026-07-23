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
	const v = detectConstraintViolations(facts, [noHistoryRule], 'mimo-v2.5');
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
	t.is(detectConstraintViolations(facts, [noHistoryRule], 'mimo-v2.5'), null);
});

test('detectConstraintViolations: gated to the rule condition — out-of-scenario → null', t => {
	// A scenario-scoped constraint (fires only during runtime-setup) must NOT
	// trip on a matching command in a DIFFERENT intent (e.g. a git probe piped
	// through head). Regression for the over-scoped alsoBlock.
	const scopedRule: SteeringRule = {
		id: 'runtime-only',
		mode: 'innerdaemon',
		condition: {intentClass: 'runtime-setup'},
		watch: {
			alsoBlock: [
				{
					tool: 'execute_bash',
					argMatches: ['| head -'],
					message: 'no truncating setup logs',
				},
			],
		},
	};
	const gitProbe = [
		makeFact({
			turnIndex: 0,
			intentClass: 'git-history',
			toolCalls: [
				toolCall('a', 'execute_bash', {command: 'git branch | head -5'}),
			],
		}),
	];
	// Different intent → constraint out of scope → no block.
	t.is(detectConstraintViolations(gitProbe, [scopedRule], 'mimo-v2.5'), null);
	// SAME intent (runtime-setup) → constraint fires.
	const setupTurn = [
		makeFact({
			turnIndex: 0,
			intentClass: 'runtime-setup',
			toolCalls: [
				toolCall('a', 'execute_bash', {command: 'npm run dev | head -5'}),
			],
		}),
	];
	t.truthy(detectConstraintViolations(setupTurn, [scopedRule], 'mimo-v2.5'));
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
	t.is(detectConstraintViolations(facts, [noHistoryRule], 'mimo-v2.5'), null);
});

// --- classifyIntent: reproduce (read/search-only proxy) --------------------

test('classifyIntent: a read-only turn (read_file + grep) is reproduce', t => {
	const tc = [
		toolCall('a', 'read_file', {path: 'src/counter.ts'}),
		toolCall('b', 'grep', {pattern: 'availment'}),
	];
	t.is(classifyIntent(tc), 'reproduce');
});

test('classifyIntent: an explore agent delegation is reproduce', t => {
	const tc = [
		toolCall('a', 'agent', {subagent: 'explore', task: 'find the classifier'}),
	];
	t.is(classifyIntent(tc), 'reproduce');
});

test('classifyIntent: a browser_* turn is NOT reproduce (reproduction already happening)', t => {
	const tc = [toolCall('a', 'browser_navigate', {url: 'http://x'})];
	t.not(classifyIntent(tc), 'reproduce');
});

test('classifyIntent: a read turn mixed with a git log stays git-history (action class wins)', t => {
	const tc = [
		toolCall('a', 'read_file', {path: 'x.ts'}),
		toolCall('b', 'execute_bash', {command: 'git log --oneline'}),
	];
	t.is(classifyIntent(tc), 'git-history');
});

test('classifyIntent: a write turn is NOT reproduce', t => {
	const tc = [toolCall('a', 'write_file', {path: 'src/x.ts'})];
	t.not(classifyIntent(tc), 'reproduce');
});

// --- evaluateRules: windowed repeat detection (repeatThreshold) ------------

const probeRule = (threshold: number, matches?: string[]): SteeringRule => ({
	id: 'hilinga-runtime-setup-loop',
	mode: 'innerdaemon',
	condition: {modelIn: [MIMO], intentClass: 'runtime-setup'},
	watch: {
		successCriterion: 'portListenerExists',
		// A high turn-budget so the ONLY thing that can trip the rule here is the
		// repeat threshold — proves the repeat gate fires independently.
		maxTurnsWithoutSuccess: 99,
		repeatThreshold: threshold,
		...(matches ? {repeatToolMatches: matches} : {}),
	},
});

const probeFact = (turnIndex: number, command: string): TurnFact =>
	makeFact({
		turnIndex,
		intentClass: 'runtime-setup',
		toolCalls: [toolCall(`p${turnIndex}`, 'execute_bash', {command})],
		toolResults: [toolResult(`p${turnIndex}`, 'execute_bash', 'refused')],
	});

test('evaluateRules: same probe repeated ≥ threshold → candidate (budget not exhausted)', t => {
	const cmd = 'lsof -i :4161 || ss -tlnp | grep 4161';
	const facts = [0, 1, 2].map(i => probeFact(i, cmd));
	const cands = evaluateRules(facts, [probeRule(3)], MIMO, alwaysFalseChecker);
	t.is(cands.length, 1);
	t.is(cands[0].rule.id, 'hilinga-runtime-setup-loop');
});

test('evaluateRules: whitespace-only difference still counts as the same probe', t => {
	const facts = [
		probeFact(0, 'lsof -i :4161'),
		probeFact(1, 'lsof  -i  :4161'),
		probeFact(2, 'lsof -i :4161'),
	];
	const cands = evaluateRules(facts, [probeRule(3)], MIMO, alwaysFalseChecker);
	t.is(cands.length, 1, 'normalized identical probes reach the threshold');
});

test('evaluateRules: fewer than threshold identical probes → no candidate', t => {
	const cmd = 'lsof -i :4161';
	const facts = [probeFact(0, cmd), probeFact(1, cmd)];
	const cands = evaluateRules(facts, [probeRule(3)], MIMO, alwaysFalseChecker);
	t.is(cands.length, 0);
});

test('evaluateRules: DIFFERENT probes each turn → no repeat candidate', t => {
	const facts = [
		probeFact(0, 'lsof -i :4161'),
		probeFact(1, 'curl -s localhost:4161'),
		probeFact(2, 'ss -tlnp | grep 4160'),
	];
	const cands = evaluateRules(facts, [probeRule(3)], MIMO, alwaysFalseChecker);
	t.is(cands.length, 0, "diverse strategies are the budget rule's job, not this one");
});

test('evaluateRules: repeat suppressed when the success criterion is met (server up)', t => {
	const cmd = 'lsof -i :4161';
	const facts = [0, 1, 2].map(i => probeFact(i, cmd));
	// alwaysTrueChecker = portListenerExists met → a confirming probe is fine.
	const cands = evaluateRules(facts, [probeRule(3)], MIMO, alwaysTrueChecker);
	t.is(cands.length, 0);
});

test('evaluateRules: repeatToolMatches scopes the signal to probe tools', t => {
	// A repeated NON-probe command (a build step) must not trip a probe-scoped
	// repeat rule, even when repeated to the threshold.
	const buildFacts = [0, 1, 2].map(i => probeFact(i, 'pnpm run build'));
	const scoped = probeRule(3, ['lsof', 'ss ', 'curl', 'netstat']);
	t.is(
		evaluateRules(buildFacts, [scoped], MIMO, alwaysFalseChecker).length,
		0,
		'a repeated build step is out of probe scope → no candidate',
	);
	// The same rule DOES fire on repeated in-scope lsof probes.
	const lsofFacts = [0, 1, 2].map(i => probeFact(i, 'lsof -i :4161'));
	t.is(
		evaluateRules(lsofFacts, [scoped], MIMO, alwaysFalseChecker).length,
		1,
		'repeated lsof probes are in scope → candidate',
	);
});

test('evaluateRules: countRepeatedLatestCall counts turns with the identical probe', async t => {
	const {countRepeatedLatestCall} = await import('./detector');
	const cmd = 'lsof -i :4161';
	const facts = [probeFact(0, cmd), probeFact(1, 'curl x'), probeFact(2, cmd)];
	t.is(
		countRepeatedLatestCall(facts, {repeatThreshold: 2}),
		2,
		"two turns issued the latest turn's probe",
	);
});

// --- evaluateRules: time/effort-aware budget (maxWallClockMsWithoutSuccess) ---
// finding #9: a slow spiral (few turns, many minutes) must trip on wall-clock
// even though the turn count is far below `maxTurnsWithoutSuccess`.

// A worktree-creation turn stamped at a specific wall-clock (ms since loop start).
const timedWorktreeFact = (turnIndex: number, wallClockMs: number): TurnFact =>
	makeFact({
		turnIndex,
		wallClockMs,
		intentClass: 'worktree-creation',
		toolCalls: [
			toolCall('a', 'execute_bash', {command: 'git worktree add x'}),
		],
		toolResults: [toolResult('a', 'execute_bash')],
	});

// A rule whose turn budget is deliberately huge (99) so the ONLY thing that can
// trip it is the wall-clock budget — proving the time gate fires independently.
const slowSpiralRule = (maxMs: number): SteeringRule => ({
	id: 'slow-spiral',
	mode: 'innerdaemon',
	condition: {intentClass: 'worktree-creation'},
	watch: {
		successCriterion: 'worktreeDirExists',
		maxTurnsWithoutSuccess: 99,
		maxWallClockMsWithoutSuccess: maxMs,
	},
});

test('evaluateRules: elapsed in-scope wall-clock ≥ budget → candidate (turn count far below turn budget)', t => {
	// 3 turns spanning 6 minutes; turn budget is 99 so turns cannot trip it.
	const facts = [
		timedWorktreeFact(0, 0),
		timedWorktreeFact(1, 120_000),
		timedWorktreeFact(2, 360_000),
	];
	const cands = evaluateRules(
		facts,
		[slowSpiralRule(300_000)], // 5-minute wall-clock budget
		MIMO,
		alwaysFalseChecker,
	);
	t.is(cands.length, 1, 'elapsed 6min ≥ 5min budget → fires on wall-clock');
	t.is(cands[0].rule.id, 'slow-spiral');
});

test('evaluateRules: elapsed wall-clock UNDER budget → no candidate', t => {
	// Same 3 turns but only 2 seconds elapsed — under the 5-minute budget.
	const facts = [
		timedWorktreeFact(0, 0),
		timedWorktreeFact(1, 1_000),
		timedWorktreeFact(2, 2_000),
	];
	const cands = evaluateRules(
		facts,
		[slowSpiralRule(300_000)],
		MIMO,
		alwaysFalseChecker,
	);
	t.is(cands.length, 0, 'elapsed 2s < 5min budget and turns < 99 → no candidate');
});

test('evaluateRules: a met success criterion resets the wall-clock window', t => {
	// The whole window spans 10 minutes, but the criterion is met each turn →
	// the in-scope window is empty, so no elapsed time accrues.
	const facts = [
		timedWorktreeFact(0, 0),
		timedWorktreeFact(1, 300_000),
		timedWorktreeFact(2, 600_000),
	];
	const cands = evaluateRules(
		facts,
		[slowSpiralRule(60_000)],
		MIMO,
		alwaysTrueChecker,
	);
	t.is(cands.length, 0, 'criterion met resets the window → wall-clock does not accrue');
});

test('evaluateRules: unpopulated wall-clock (0) is no time signal → byte-identical to turn-only', t => {
	// All turns at wallClockMs 0 (no instrumentation). With the turn budget high,
	// neither gate trips — exactly as the turn-count-only path behaved.
	const facts = [0, 1, 2].map(i => timedWorktreeFact(i, 0));
	const cands = evaluateRules(
		facts,
		[slowSpiralRule(1)], // even a 1ms budget must NOT fire without a real clock
		MIMO,
		alwaysFalseChecker,
	);
	t.is(cands.length, 0, 'wallClockMs 0 → treated as no time signal');
});
