import test from 'ava';
import {getSubagentLoader} from '@/subagents/subagent-loader';
import {executeBashTool} from '@/tools/execute-bash';
import type {ToolManager} from '@/tools/tool-manager';
import type {LLMChatResponse, LLMClient, ToolCall} from '@/types/core';
import {setGlobalToolApprovalHandler} from '@/utils/tool-approval-queue';
import {withValidation} from '@/utils/tool-validation';
import {createInnerDaemonExecutor} from './index.js';

console.log('\ninnerdaemon-executor.spec.ts');

// ============================================================================
// Regression: InnerDaemon's executor must honor the LIVE development mode.
//
// Bug: useChatHandler bound the steering engine to `new SubagentExecutor(...)`
// with no mode resolver, so the executor snapshotted 'normal' forever. In
// `--mode yolo`, every InnerDaemon escalation that ran a benign read-only
// execute_bash probe (curl/lsof/ss port checks) popped a spurious
// "Do you want to execute tool execute_bash?" confirmation and stalled the
// run (documented as "block + yolo → spurious confirmation").
// ============================================================================

const BENIGN_PROBE =
	'curl -s -o /dev/null -w "%{http_code}" http://localhost:4161/';
const DANGEROUS_COMMAND = 'rm -rf /';

/** Approval requests recorded by the test approval handler. */
let approvalRequests: ToolCall[] = [];

/**
 * Tool manager exposing execute_bash with the REAL approval policy and REAL
 * dangerous-pattern validator, but a fake handler (no shell is spawned).
 */
function createBashToolManager(onBash: (command: string) => void): ToolManager {
	const bashHandler = withValidation(async (args: unknown) => {
		const {command} = args as {command: string};
		onBash(command);
		return `ran: ${command}`;
	}, executeBashTool.validator);

	const entry = {
		approval: executeBashTool.approval,
		readOnly: false,
	};

	return {
		getAllTools: () => ({execute_bash: {execute: bashHandler}}),
		getToolHandler: (name: string) =>
			name === 'execute_bash' ? bashHandler : undefined,
		getToolEntry: (name: string) =>
			name === 'execute_bash' ? entry : undefined,
		isReadOnly: () => false,
		getToolFormatter: () => undefined,
		getStreamingFormatter: () => undefined,
	} as unknown as ToolManager;
}

/** Mock client: one execute_bash tool call, then a noop steering decision. */
function createProbeClient(command: string): LLMClient {
	const responses = [
		{
			content: '',
			tool_calls: [
				{
					id: 'probe-1',
					function: {
						name: 'execute_bash',
						arguments: JSON.stringify({command}),
					},
				},
			],
		},
		{content: 'ACTION: noop\nREASON: main agent on track'},
	];
	let callIndex = 0;
	let currentModel = 'test-model';
	return {
		chat: async (): Promise<LLMChatResponse> => {
			const response = responses[callIndex] ?? {content: 'fallback'};
			callIndex++;
			return {
				choices: [{message: response}],
				toolsDisabled: false,
			} as unknown as LLMChatResponse;
		},
		getCurrentModel: () => currentModel,
		setModel: (model: string) => {
			currentModel = model;
		},
		getAvailableModels: async () => ['test-model'],
		getContextSize: () => 128000,
		getProviderConfig: () => ({
			name: 'TestProvider',
			type: 'openai',
			models: ['test-model'],
			config: {},
		}),
		clearContext: async () => {},
		getTimeout: () => undefined,
	} as unknown as LLMClient;
}

test.before(async () => {
	await getSubagentLoader().initialize();
});

test.beforeEach(() => {
	approvalRequests = [];
	setGlobalToolApprovalHandler(async req => {
		approvalRequests.push(req.toolCall);
		return true;
	});
});

test.serial(
	'yolo: InnerDaemon benign execute_bash probe runs with NO approval prompt',
	async t => {
		const commands: string[] = [];
		const executor = createInnerDaemonExecutor(
			createBashToolManager(cmd => commands.push(cmd)),
			createProbeClient(BENIGN_PROBE),
			() => 'yolo',
		);

		const result = await executor.execute({
			subagent_type: 'innerdaemon',
			description: 'steering check',
			prompt: 'verify whether the dev server port is listening',
		});

		t.true(result.success);
		// The whole bug: in yolo this prompted. It must not.
		t.is(approvalRequests.length, 0);
		t.deepEqual(commands, [BENIGN_PROBE]);
	},
);

test.serial(
	'normal: InnerDaemon execute_bash probe still requires approval (posture unchanged)',
	async t => {
		const commands: string[] = [];
		const executor = createInnerDaemonExecutor(
			createBashToolManager(cmd => commands.push(cmd)),
			createProbeClient(BENIGN_PROBE),
			() => 'normal',
		);

		const result = await executor.execute({
			subagent_type: 'innerdaemon',
			description: 'steering check',
			prompt: 'verify whether the dev server port is listening',
		});

		t.true(result.success);
		t.is(approvalRequests.length, 1);
		t.is(approvalRequests[0].function.name, 'execute_bash');
		// Approved by the test handler, so it still ran.
		t.deepEqual(commands, [BENIGN_PROBE]);
	},
);

test.serial(
	'yolo: genuinely dangerous command is still blocked by the validator',
	async t => {
		const commands: string[] = [];
		const executor = createInnerDaemonExecutor(
			createBashToolManager(cmd => commands.push(cmd)),
			createProbeClient(DANGEROUS_COMMAND),
			() => 'yolo',
		);

		const result = await executor.execute({
			subagent_type: 'innerdaemon',
			description: 'steering check',
			prompt: 'verify state',
		});

		t.true(result.success);
		// No prompt in yolo — but the dangerous-pattern validator refuses
		// execution outright, in every mode: the handler never runs.
		t.is(approvalRequests.length, 0);
		t.deepEqual(commands, []);
	},
);

test.serial(
	'live mode resolver: a mid-run switch to yolo takes effect on the next probe',
	async t => {
		let mode: 'normal' | 'yolo' = 'normal';
		const commands: string[] = [];
		const toolManager = createBashToolManager(cmd => commands.push(cmd));

		const first = createInnerDaemonExecutor(
			toolManager,
			createProbeClient(BENIGN_PROBE),
			() => mode,
		);
		await first.execute({
			subagent_type: 'innerdaemon',
			description: 'steering check',
		});
		t.is(approvalRequests.length, 1);

		mode = 'yolo';
		approvalRequests = [];
		const second = createInnerDaemonExecutor(
			toolManager,
			createProbeClient(BENIGN_PROBE),
			() => mode,
		);
		await second.execute({
			subagent_type: 'innerdaemon',
			description: 'steering check',
		});
		t.is(approvalRequests.length, 0);
	},
);
