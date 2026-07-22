import test from 'ava';
import type {ToolCall, ToolResult} from '@/types/core';
import {SteeringEngine, type InnerDaemonInvoker} from './steering-engine';
import type {InnerDaemonResponse, SteeringRule, TurnFact} from './types';

console.log('\nsteering/steering-engine.spec.ts');

// --- fixtures --------------------------------------------------------------

const toolCall = (
	id: string,
	name: string,
	args: Record<string, unknown> = {},
): ToolCall => ({id, function: {name, arguments: args}});

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

const worktreeFact = (turnIndex: number): TurnFact =>
	makeFact({
		turnIndex,
		intentClass: 'worktree-creation',
		toolCalls: [
			toolCall(`a${turnIndex}`, 'execute_bash', {
				command: 'git worktree add .claude/worktrees/x',
			}),
		],
		toolResults: [toolResult(`a${turnIndex}`, 'execute_bash', 'created')],
	});

const MIMO = 'mimo-v2.5';

const worktreeRule: SteeringRule = {
	id: 'worktree-supervision',
	mode: 'innerdaemon',
	maxFires: 3,
	cooldownTurns: 1,
	condition: {
		modelIn: ['mimo-v2.5'],
		intentClass: 'worktree-creation',
	},
	watch: {successCriterion: 'worktreeDirExists', maxTurnsWithoutSuccess: 2},
	body: 'Use the scripts. Do not hand-roll.',
};

// checker that always says the criterion is NOT met (worktree never created)
const neverMet = () => false;
// checker that always says the criterion IS met
const alwaysMet = () => true;

/** Build an engine with a mock InnerDaemon returning the given canned response. */
const engineWith = (
	rules: SteeringRule[],
	innerdaemonResponse: InnerDaemonResponse,
	criterion = neverMet,
): SteeringEngine =>
	new SteeringEngine({
		rules,
		modelId: MIMO,
		criterionChecker: criterion,
		innerdaemon: (async () => innerdaemonResponse) as InnerDaemonInvoker,
	});

// --- constraint violation (instant block, no InnerDaemon) -------------------

test('evaluate: git log constraint → instant block, no InnerDaemon call', async t => {
	let innerdaemonCalled = false;
	const rule: SteeringRule = {
		id: 'no-history',
		mode: 'detector-only',
		watch: {
			alsoBlock: [
				{
					tool: 'execute_bash',
					argMatches: ['git log'],
					message: 'git history forbidden',
				},
			],
		},
	};
	const engine = new SteeringEngine({
		rules: [rule],
		modelId: MIMO,
		criterionChecker: neverMet,
		innerdaemon: async () => {
			innerdaemonCalled = true;
			return {action: 'noop', reason: ''};
		},
	});
	const facts = [
		makeFact({
			turnIndex: 0,
			toolCalls: [
				toolCall('a', 'execute_bash', {command: 'git log -1 main'}),
			],
		}),
	];
	const action = await engine.evaluate(facts);
	t.deepEqual(action, {
		type: 'block',
		toolCallIds: ['a'],
		message: 'git history forbidden',
		urgency: 'light',
	});
	t.false(innerdaemonCalled, 'InnerDaemon must not be called for a constraint block');
});

// --- innerdaemon candidate: budget + delegation -----------------------------

test('evaluate: budget not exceeded → no candidate, no InnerDaemon call', async t => {
	let innerdaemonCalled = false;
	const engine = engineWith(
		[worktreeRule],
		{action: 'inject', message: 'nudge', urgency: 'light'},
	);
	(engine as unknown as {innerdaemon: () => Promise<InnerDaemonResponse>}).innerdaemon =
		async () => {
			innerdaemonCalled = true;
			return {action: 'inject', message: 'x', urgency: 'light'};
		};
	// only 1 turn in-scope, budget=2 → not exceeded
	const facts = [worktreeFact(0)];
	const action = await engine.evaluate(facts);
	t.is(action, null);
	t.false(innerdaemonCalled);
});

test('evaluate: budget exceeded → InnerDaemon inject fires', async t => {
	const engine = engineWith(
		[worktreeRule],
		{action: 'inject', message: 'use the scripts', urgency: 'light'},
	);
	// 3 turns in-scope, budget=2 → exceeded
	const facts = [worktreeFact(0), worktreeFact(1), worktreeFact(2)];
	const action = await engine.evaluate(facts);
	t.deepEqual(action, {type: 'inject', message: 'use the scripts', urgency: 'light'});
});

test('evaluate: criterion already met → no candidate (false alarm)', async t => {
	const engine = engineWith(
		[worktreeRule],
		{action: 'inject', message: 'should not fire', urgency: 'light'},
		alwaysMet,
	);
	const facts = [worktreeFact(0), worktreeFact(1), worktreeFact(2)];
	const action = await engine.evaluate(facts);
	t.is(action, null);
});

test('evaluate: InnerDaemon noop does not burn a fire slot', async t => {
	let calls = 0;
	const engine = new SteeringEngine({
		rules: [worktreeRule],
		modelId: MIMO,
		criterionChecker: neverMet,
		innerdaemon: async () => {
			calls++;
			return {action: 'noop', reason: 'false alarm'};
		},
	});
	const facts = [worktreeFact(0), worktreeFact(1), worktreeFact(2)];
	// First eval: noop. Should not count as a fire.
	t.is(await engine.evaluate(facts), null);
	// Advance a turn (out of cooldown), still noop — still not counted.
	facts.push(worktreeFact(3));
	t.is(await engine.evaluate(facts), null);
	t.is(calls, 2, 'InnerDaemon called twice');
	// Fire state should still be at 0 fires (noops don't count).
	const fires = (engine as unknown as {state: {fires: Map<string, {count: number}>}}).state.fires;
	t.is(fires.get('worktree-supervision')?.count ?? 0, 0);
});

// --- maxFires escalation ---------------------------------------------------

test('evaluate: after maxFires real injections, escalate to stop', async t => {
	const engine = engineWith(
		[worktreeRule], // maxFires: 3, cooldownTurns: 1
		{action: 'inject', message: 'nudge', urgency: 'light'},
	);
	// Turn 2: first fire (budget 2 exceeded)
	let action = await engine.evaluate([worktreeFact(0), worktreeFact(1), worktreeFact(2)]);
	t.is(action?.type, 'inject');
	// Turn 4: second fire (cooldown 1 → turn 4 ok)
	action = await engine.evaluate([worktreeFact(0), worktreeFact(1), worktreeFact(2), worktreeFact(3), worktreeFact(4)]);
	t.is(action?.type, 'inject');
	// Turn 6: third fire
	action = await engine.evaluate([
		worktreeFact(0), worktreeFact(1), worktreeFact(2),
		worktreeFact(3), worktreeFact(4), worktreeFact(5), worktreeFact(6),
	]);
	t.is(action?.type, 'inject');
	// Turn 8: maxFires (3) exceeded → stop, no InnerDaemon call
	let innerdaemonCalls = 0;
	(engine as unknown as {innerdaemon: () => Promise<InnerDaemonResponse>}).innerdaemon =
		async () => {
			innerdaemonCalls++;
			return {action: 'inject', message: 'x', urgency: 'light'};
		};
	action = await engine.evaluate([
		...Array.from({length: 8}, (_, i) => worktreeFact(i)),
	]);
	t.is(action?.type, 'stop');
	t.is(innerdaemonCalls, 0, 'must not call InnerDaemon after maxFires');
});

// --- cooldown --------------------------------------------------------------

test('evaluate: rule in cooldown is skipped, next candidate tried', async t => {
	// Two rules: the worktree one (cooldown 1) and a universal detector-only
	// fallback that should fire when the first is cooling down.
	const detectorRule: SteeringRule = {
		id: 'universal-fallback',
		mode: 'detector-only',
		condition: {modelIn: ['mimo-v2.5']},
		body: 'Stay on task.',
	};
	let innerdaemonCalls = 0;
	const engine = new SteeringEngine({
		rules: [worktreeRule, detectorRule],
		modelId: MIMO,
		criterionChecker: neverMet,
		innerdaemon: async () => {
			innerdaemonCalls++;
			return {action: 'inject', message: 'wt nudge', urgency: 'light'};
		},
	});
	const facts = [worktreeFact(0), worktreeFact(1), worktreeFact(2)];
	// First eval: worktree rule fires (inject).
	t.is((await engine.evaluate(facts))?.type, 'inject');
	t.is(innerdaemonCalls, 1);
	// Second eval same turn window: worktree rule in cooldown (lastFire=2,
	// cooldown=1, turn 2 - 2 = 0 < 1 → skip), so the detector-only fallback
	// fires instead.
	const action = await engine.evaluate(facts);
	t.is(action?.type, 'inject');
	t.true(
		(action as {message?: string})?.message?.includes('universal-fallback'),
		'detector-only fallback fired while innerdaemon rule cooled down',
	);
});

// --- detector-only rule ----------------------------------------------------

test('evaluate: detector-only rule acts directly, no InnerDaemon call', async t => {
	let innerdaemonCalled = false;
	const rule: SteeringRule = {
		id: 'always-nudge',
		mode: 'detector-only',
		condition: {modelIn: ['mimo-v2.5']},
		body: 'First line of guidance.',
	};
	const engine = new SteeringEngine({
		rules: [rule],
		modelId: MIMO,
		criterionChecker: neverMet,
		innerdaemon: async () => {
			innerdaemonCalled = true;
			return {action: 'noop', reason: ''};
		},
	});
	const action = await engine.evaluate([worktreeFact(0)]);
	t.is(action?.type, 'inject');
	t.false(innerdaemonCalled);
});

// --- model gate end-to-end ------------------------------------------------

test('evaluate: Claude session → no steering (model gate at engine level)', async t => {
	const engine = new SteeringEngine({
		rules: [worktreeRule],
		modelId: 'claude-sonnet-4-6',
		criterionChecker: neverMet,
		innerdaemon: async () => ({action: 'inject', message: 'x', urgency: 'light'}),
	});
	const facts = [worktreeFact(0), worktreeFact(1), worktreeFact(2), worktreeFact(3)];
	t.is(await engine.evaluate(facts), null);
});

// --- empty facts ----------------------------------------------------------

test('evaluate: empty facts → null', async t => {
	const engine = engineWith([worktreeRule], {action: 'inject', message: 'x', urgency: 'light'});
	t.is(await engine.evaluate([]), null);
});

// --- createCriterionChecker (observable predicates) -----------------------

test('createCriterionChecker: worktreeDirExists via successful worktree-create output', async t => {
	const {createCriterionChecker} = await import('./steering-engine');
	const checker = createCriterionChecker(() => '/mnt/x/Hilinga');
	const fact = makeFact({
		toolResults: [
			toolResult('a', 'execute_bash', 'worktree-create.sh ran, plugins 10/10'),
		],
	});
	t.true(checker('worktreeDirExists', fact));
});

test('createCriterionChecker: worktreeDirExists is stateful — populated worktree stays met (rule dormant in later phases); bare mkdir does not', async t => {
	const {mkdtempSync, mkdirSync, writeFileSync} = await import('node:fs');
	const {join} = await import('node:path');
	const {tmpdir} = await import('node:os');
	const {createCriterionChecker} = await import('./steering-engine');

	const root = mkdtempSync(join(tmpdir(), 'steer-wt-'));
	// A fully-built worktree (populated) — the reproduce/TDD/fix phases merely
	// reference it by path.
	mkdirSync(join(root, '.claude', 'worktrees', 'built', 'kserp'), {
		recursive: true,
	});
	writeFileSync(join(root, '.claude', 'worktrees', 'built', 'kserp', '.env'), 'x');
	// A bare hand-rolled empty mkdir — the failure mode the rule targets.
	mkdirSync(join(root, '.claude', 'worktrees', 'empty'), {recursive: true});

	const checker = createCriterionChecker(() => root);

	const referencesBuilt = makeFact({
		toolCalls: [
			toolCall('a', 'execute_bash', {
				command: `ls ${root}/.claude/worktrees/built/`,
			}),
		],
	});
	t.true(
		checker('worktreeDirExists', referencesBuilt),
		'populated worktree → met (create-only rule goes dormant, no false-fire in reproduce)',
	);

	const bareMkdir = makeFact({
		toolCalls: [
			toolCall('b', 'execute_bash', {
				command: `mkdir -p ${root}/.claude/worktrees/empty`,
			}),
		],
	});
	t.false(
		checker('worktreeDirExists', bareMkdir),
		'empty mkdir → not met (rule still fires on a hand-roll)',
	);
});

test('createCriterionChecker: worktreeDirExists false on error output', async t => {
	const {createCriterionChecker} = await import('./steering-engine');
	const checker = createCriterionChecker(() => '/mnt/x/Hilinga');
	const fact = makeFact({
		toolResults: [toolResult('a', 'execute_bash', 'Error: concurrently not found')],
	});
	t.false(checker('worktreeDirExists', fact));
});

test('createCriterionChecker: cwd under worktrees/ → true', async t => {
	const {createCriterionChecker} = await import('./steering-engine');
	const checker = createCriterionChecker(() => '/mnt/x/Hilinga');
	const fact = makeFact({cwd: '/mnt/x/Hilinga/.claude/worktrees/foo'});
	t.true(checker('worktreeDirExists', fact));
});

test('createCriterionChecker: portListenerExists via listening output', async t => {
	const {createCriterionChecker} = await import('./steering-engine');
	const checker = createCriterionChecker(() => '/mnt/x');
	t.true(
		checker(
			'portListenerExists',
			makeFact({
				toolResults: [toolResult('a', 'execute_bash', 'API listening on localhost:4661')],
			}),
		),
	);
	t.false(
		checker(
			'portListenerExists',
			makeFact({
				toolResults: [toolResult('a', 'execute_bash', 'ECONNREFUSED localhost:4661')],
			}),
		),
	);
});

test('createCriterionChecker: portListenerExists is stateful — a real listening socket → met (rule dormant); a dead port falls back to the output heuristic', async t => {
	const net = await import('node:net');
	const {createCriterionChecker} = await import('./steering-engine');
	const checker = createCriterionChecker(() => '/mnt/x');

	// Bind a real listening socket on a free port (node picks one via :0).
	const server = net.createServer();
	await new Promise<void>(resolve =>
		server.listen(0, '127.0.0.1', () => resolve()),
	);
	const addr = server.address();
	const port = typeof addr === 'object' && addr ? addr.port : 0;

	try {
		// A turn that references the genuinely-listening port, but whose OUTPUT
		// carries NO listening/ready keyword — so only the stateful `/proc`
		// socket probe can make this met (the old output heuristic would say
		// unmet). Linux-only assertion (proc parsing is Linux).
		const referencesLive = makeFact({
			toolCalls: [
				toolCall('a', 'execute_bash', {
					command: `curl -s -o /dev/null http://localhost:${port}/`,
				}),
			],
			toolResults: [toolResult('a', 'execute_bash', '200')],
		});
		if (process.platform === 'linux') {
			t.true(
				checker('portListenerExists', referencesLive),
				'genuinely listening port → met via /proc socket probe (rule dormant)',
			);
		} else {
			t.pass('non-Linux: /proc probe unavailable, skipping the live assertion');
		}

		// A dead port (nothing listening): the stateful probe fails, so the
		// result falls back to the output-based heuristic.
		const deadPort = 1; // privileged, guaranteed not our listener
		t.true(
			checker(
				'portListenerExists',
				makeFact({
					toolResults: [
						toolResult(
							'a',
							'execute_bash',
							`ready in 200ms on localhost:${deadPort}`,
						),
					],
				}),
			),
			'dead port + positive output → heuristic fallback says met',
		);
		t.false(
			checker(
				'portListenerExists',
				makeFact({
					toolResults: [
						toolResult(
							'a',
							'execute_bash',
							`ECONNREFUSED localhost:${deadPort}`,
						),
					],
				}),
			),
			'dead port + error output → not met',
		);
	} finally {
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
});

test('createCriterionChecker: newTestFileExists via write_file to .spec.ts', async t => {
	const {createCriterionChecker} = await import('./steering-engine');
	const checker = createCriterionChecker(() => '/mnt/x');
	t.true(
		checker(
			'newTestFileExists',
			makeFact({
				toolCalls: [toolCall('a', 'write_file', {path: 'tests/x.spec.ts'})],
			}),
		),
	);
	t.false(
		checker(
			'newTestFileExists',
			makeFact({
				toolCalls: [toolCall('a', 'write_file', {path: 'src/x.ts'})],
			}),
		),
	);
});
