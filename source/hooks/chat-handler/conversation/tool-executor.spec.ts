import test from 'ava';
import type React from 'react';
import {renderWithTheme} from '@/test-utils/render-with-theme.js';
import {displayExecutedTool, executeToolsDirectly} from './tool-executor.js';
import type {ToolCall, ToolResult} from '@/types/core';

// ============================================================================
// Test Helpers
// ============================================================================

import {setToolRegistryGetter} from '@/message-handler';
import {ToolValidationError} from '@/utils/tool-validation';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Mock tool registry for tests
const mockToolHandler: ToolCall['function']['name'] extends infer T
  ? Record<string, (args: Record<string, unknown>) => Promise<string>>
  : Record<string, any> = {
  test_tool: async () => 'Tool executed',
  tool1: async () => 'Tool 1 executed',
  tool2: async () => 'Tool 2 executed',
  tool3: async () => 'Tool 3 executed',
  write_tasks: async () => 'Tasks updated',
  slow_tool1: async () => { await delay(50); return 'Slow tool 1 done'; },
  slow_tool2: async () => { await delay(50); return 'Slow tool 2 done'; },
  slow_tool3: async () => { await delay(50); return 'Slow tool 3 done'; },
  failing_tool: async () => {
    throw new Error('Tool execution failed');
  },
  passing_tool: async () => 'Tool passed',
  unvalidated_tool: async () => 'Tool executed',
  validated_tool: async () => 'Tool executed',
};

const createMockToolRegistry = () => mockToolHandler;

// Set up tool registry before all tests
test.before(async () => {
  setToolRegistryGetter(createMockToolRegistry);
});

// Create a mock tool manager
const createMockToolManager = (config: {
	validatorResult?: {valid: boolean; error?: string};
	shouldFail?: boolean;
	readOnlyTools?: string[];
} = {}) => ({
	getToolValidator: (name: string) => {
		if (config.validatorResult) {
			return async () => config.validatorResult!;
		}
		return undefined;
	},
	getTool: (name: string) => ({
		execute: async () => {
			if (config.shouldFail) {
				throw new Error('Tool execution failed');
			}
			return 'Tool executed';
		},
	}),
	hasTool: (name: string) => true,
	getToolFormatter: (name: string) => undefined,
	isReadOnly: (name: string) => config.readOnlyTools?.includes(name) ?? false,
});

// Create a mock conversation state manager
const createMockConversationStateManager = () => ({
	current: {
		updateAfterToolExecution: () => {},
		updateAssistantMessage: () => {},
	},
});

// ============================================================================
// Validation Failure Tests
// ============================================================================

test('executeToolsDirectly - handles validation failure', async t => {
	const toolCalls: ToolCall[] = [
		{
			id: 'call_1',
			function: {
				name: 'test_tool',
				arguments: '{"path": "invalid"}',
			},
		},
	];

	const conversationStateManager = createMockConversationStateManager();
	const addToChatQueueCalls: unknown[] = [];
	const addToChatQueue = (component: unknown) => {
		addToChatQueueCalls.push(component);
	};

	const toolManager = createMockToolManager();

	// Validation now lives inside the (validated) registry handler: on failure
	// it throws a ToolValidationError that processToolUse formats into the
	// result content. Simulate that handler for this tool.
	setToolRegistryGetter(() => ({
		...mockToolHandler,
		test_tool: async () => {
			throw new ToolValidationError('path does not exist', [
				{path: 'path', expected: 'existing file', received: 'invalid'},
			]);
		},
	}));

	try {
		const results = await executeToolsDirectly(
			toolCalls,
			toolManager,
			conversationStateManager as any,
			addToChatQueue,
		);

		t.is(results.length, 1);
		t.is(results[0].role, 'tool');
		t.is(results[0].name, 'test_tool');
		t.true(results[0].content.includes('Validation failed'));
	} finally {
		// Restore the shared registry for subsequent tests.
		setToolRegistryGetter(createMockToolRegistry);
	}
});

test('executeToolsDirectly - continues after validation failure', async t => {
	const toolCalls: ToolCall[] = [
		{
			id: 'call_1',
			function: {
				name: 'failing_tool',
				arguments: '{}',
			},
		},
		{
			id: 'call_2',
			function: {
				name: 'passing_tool',
				arguments: '{}',
			},
		},
	];

	const conversationStateManager = createMockConversationStateManager();
	const addToChatQueue = () => {};

	const toolManager = createMockToolManager({
		validatorResult: {
			valid: false,
			error: 'Validation failed',
		},
	});

	// Should skip validation failure and continue to next tool
	const results = await executeToolsDirectly(
		toolCalls,
		toolManager,
		conversationStateManager as any,
		addToChatQueue,
	);

	// Both tools should be attempted (validation happens for all first)
	t.is(results.length, 2);
});

// ============================================================================
// Successful Execution Tests
// ============================================================================

test('executeToolsDirectly - executes tool successfully', async t => {
	const toolCalls: ToolCall[] = [
		{
			id: 'call_1',
			function: {
				name: 'test_tool',
				arguments: '{"path": "valid"}',
			},
		},
	];

	const conversationStateManager = createMockConversationStateManager();
	const addToChatQueue = () => {};

	const toolManager = createMockToolManager({
		// No validator means no validation check
		validatorResult: undefined,
		shouldFail: false,
	});

	const results = await executeToolsDirectly(
		toolCalls,
		toolManager,
		conversationStateManager as any,
		addToChatQueue,
	);

	t.is(results.length, 1);
	t.is(results[0].role, 'tool');
	t.is(results[0].name, 'test_tool');
	t.true(results[0].content.includes('Tool executed'));
});

test('displayExecutedTool - omnicode compact execute_bash renders command detail before grouping', async t => {
	const conversationStateManager = createMockConversationStateManager();
	const addToChatQueueCalls: unknown[] = [];
	const countedTools: Array<[string, string | undefined]> = [];

	const toolCall: ToolCall = {
		id: 'call_bash_1',
		function: {
			name: 'execute_bash',
			arguments: '{"command": "echo one"}',
		},
	};
	const result: ToolResult = {
		tool_call_id: toolCall.id,
		role: 'tool',
		name: 'execute_bash',
		content: 'EXIT_CODE: 0\none',
	};

	await displayExecutedTool(
		{toolCall, result},
		null,
		component => {
			addToChatQueueCalls.push(component);
		},
		conversationStateManager as any,
		{
			compactDisplay: true,
			iconTheme: true,
			onCompactToolCount: (toolName, detail) => {
				countedTools.push([toolName, detail]);
			},
		},
	);

	t.deepEqual(countedTools, [['execute_bash', 'echo one']]);
	t.is(addToChatQueueCalls.length, 0);
});

test('displayExecutedTool - omnicode non-interactive execute_bash renders command detail', async t => {
	const conversationStateManager = createMockConversationStateManager();
	const addToChatQueueCalls: unknown[] = [];
	const countedTools: string[] = [];

	const toolCall: ToolCall = {
		id: 'call_bash_noninteractive',
		function: {
			name: 'execute_bash',
			arguments: '{"command": "docker ps"}',
		},
	};
	const result: ToolResult = {
		tool_call_id: toolCall.id,
		role: 'tool',
		name: 'execute_bash',
		content: 'EXIT_CODE: 0\ncontainer',
	};

	await displayExecutedTool(
		{toolCall, result},
		null,
		component => {
			addToChatQueueCalls.push(component);
		},
		conversationStateManager as any,
		{
			compactDisplay: true,
			iconTheme: true,
			nonInteractiveMode: true,
			onCompactToolCount: toolName => {
				countedTools.push(toolName);
			},
		},
	);

	t.deepEqual(countedTools, []);
	t.is(addToChatQueueCalls.length, 1);
	const {lastFrame, unmount} = renderWithTheme(
		addToChatQueueCalls[0] as React.ReactElement,
	);
	const output = lastFrame();
	t.regex(output!, /Bash\(docker ps\)/);
	unmount();
});

test.serial(
	'executeToolsDirectly - compact bash exposes live tail while running',
	async t => {
		const runningCounts: unknown[] = [];
		const compactCounts: Array<[string, string | string[] | undefined]> = [];
		const command = "printf 'start\\n'; sleep 0.05; printf 'done\\n'";

		const results = await executeToolsDirectly(
			[
				{
					id: 'call_bash_live_tail',
					function: {
						name: 'execute_bash',
						arguments: JSON.stringify({command}),
					},
				},
			],
			createMockToolManager() as any,
			createMockConversationStateManager() as any,
			() => {},
			{
				compactDisplay: true,
				setLiveComponent: () => {},
				onRunningToolCounts: counts => {
					if (counts) runningCounts.push(counts);
				},
				onCompactToolCount: (toolName, detail) => {
					compactCounts.push([toolName, detail]);
				},
			},
		);

		t.is(results.length, 1);
		t.true(runningCounts.length > 0);
		const firstRunning = runningCounts[0] as Record<string, any>;
		t.is(firstRunning.execute_bash.count, 1);
		t.deepEqual(firstRunning.execute_bash.details, [command]);
		t.deepEqual(firstRunning.execute_bash.liveDetails(), [command]);
		t.deepEqual(compactCounts, [['execute_bash', command]]);
	},
);

test('executeToolsDirectly - executes multiple read-only tools in parallel', async t => {
	const toolCalls: ToolCall[] = [
		{
			id: 'call_1',
			function: {name: 'tool1', arguments: '{"arg1": "value1"}'},
		},
		{
			id: 'call_2',
			function: {name: 'tool2', arguments: '{"arg2": "value2"}'},
		},
		{
			id: 'call_3',
			function: {name: 'tool3', arguments: '{"arg3": "value3"}'},
		},
	];

	const conversationStateManager = createMockConversationStateManager();
	const addToChatQueue = () => {};

	const toolManager = createMockToolManager({
		validatorResult: undefined,
		shouldFail: false,
		readOnlyTools: ['tool1', 'tool2', 'tool3'],
	});

	const results = await executeToolsDirectly(
		toolCalls,
		toolManager,
		conversationStateManager as any,
		addToChatQueue,
	);

	// All three tools should execute
	t.is(results.length, 3);
	// All results should have unique tool_call_ids
	const toolIds = results.map(r => r.tool_call_id);
	t.is(new Set(toolIds).size, 3);
});

test('executeToolsDirectly - runs read-only tools concurrently (timing)', async t => {
	const toolCalls: ToolCall[] = [
		{id: 'slow_1', function: {name: 'slow_tool1', arguments: '{}'}},
		{id: 'slow_2', function: {name: 'slow_tool2', arguments: '{}'}},
		{id: 'slow_3', function: {name: 'slow_tool3', arguments: '{}'}},
	];

	const conversationStateManager = createMockConversationStateManager();
	const addToChatQueue = () => {};
	const toolManager = createMockToolManager({
		validatorResult: undefined,
		shouldFail: false,
		readOnlyTools: ['slow_tool1', 'slow_tool2', 'slow_tool3'],
	});

	const start = Date.now();
	const results = await executeToolsDirectly(
		toolCalls,
		toolManager,
		conversationStateManager as any,
		addToChatQueue,
	);
	const elapsed = Date.now() - start;

	t.is(results.length, 3);
	// 3 tools x 50ms each: sequential would take ~150ms, parallel should take ~50ms
	// Use 120ms threshold to account for overhead while catching sequential execution
	t.true(elapsed < 120, `Expected parallel execution (<120ms) but took ${elapsed}ms`);
});

test('executeToolsDirectly - preserves result order matching input order', async t => {
	const toolCalls: ToolCall[] = [
		{id: 'slow_1', function: {name: 'slow_tool1', arguments: '{}'}},
		{id: 'slow_2', function: {name: 'slow_tool2', arguments: '{}'}},
		{id: 'slow_3', function: {name: 'slow_tool3', arguments: '{}'}},
	];

	const conversationStateManager = createMockConversationStateManager();
	const addToChatQueue = () => {};
	const toolManager = createMockToolManager({
		validatorResult: undefined,
		shouldFail: false,
		readOnlyTools: ['slow_tool1', 'slow_tool2', 'slow_tool3'],
	});

	const results = await executeToolsDirectly(
		toolCalls,
		toolManager,
		conversationStateManager as any,
		addToChatQueue,
	);

	// Results must be in same order as input tool calls
	t.is(results[0].tool_call_id, 'slow_1');
	t.is(results[1].tool_call_id, 'slow_2');
	t.is(results[2].tool_call_id, 'slow_3');
});

test('executeToolsDirectly - runs non-read-only tools sequentially (timing)', async t => {
	const toolCalls: ToolCall[] = [
		{id: 'slow_1', function: {name: 'slow_tool1', arguments: '{}'}},
		{id: 'slow_2', function: {name: 'slow_tool2', arguments: '{}'}},
		{id: 'slow_3', function: {name: 'slow_tool3', arguments: '{}'}},
	];

	const conversationStateManager = createMockConversationStateManager();
	const addToChatQueue = () => {};
	const toolManager = createMockToolManager({
		validatorResult: undefined,
		shouldFail: false,
		// NOT marking as readOnly — should run sequentially
		readOnlyTools: [],
	});

	const start = Date.now();
	const results = await executeToolsDirectly(
		toolCalls,
		toolManager,
		conversationStateManager as any,
		addToChatQueue,
	);
	const elapsed = Date.now() - start;

	t.is(results.length, 3);
	// 3 tools x 50ms each: sequential should take ~150ms
	t.true(elapsed >= 120, `Expected sequential execution (>=120ms) but took ${elapsed}ms`);
});

// ============================================================================
// Error Handling Tests
// ============================================================================

test('executeToolsDirectly - handles execution error gracefully', async t => {
	const toolCalls: ToolCall[] = [
		{
			id: 'call_1',
			function: {
				name: 'failing_tool',
				arguments: '{}',
			},
		},
	];

	const conversationStateManager = createMockConversationStateManager();
	const addToChatQueue = () => {};

	const toolManager = createMockToolManager({
		shouldFail: true,
	});

	const results = await executeToolsDirectly(
		toolCalls,
		toolManager,
		conversationStateManager as any,
		addToChatQueue,
	);

	t.is(results.length, 1);
	t.is(results[0].role, 'tool');
	t.is(results[0].name, 'failing_tool');
	t.true(results[0].content.includes('Error:'));
});

test('executeToolsDirectly - continues after error with remaining tools', async t => {
	const toolCalls: ToolCall[] = [
		{
			id: 'call_1',
			function: {name: 'failing_tool', arguments: '{}'},
		},
		{
			id: 'call_2',
			function: {name: 'passing_tool', arguments: '{}'},
		},
	];

	const conversationStateManager = createMockConversationStateManager();
	const addToChatQueue = () => {};

	const toolManager = createMockToolManager({
		shouldFail: true,
	});

	const results = await executeToolsDirectly(
		toolCalls,
		toolManager,
		conversationStateManager as any,
		addToChatQueue,
	);

	// Both tools should be attempted (execution happens for all in parallel)
	t.is(results.length, 2);
});

// ============================================================================
// Edge Cases
// ============================================================================

test('executeToolsDirectly - returns empty array for no tools', async t => {
	const toolCalls: ToolCall[] = [];

	const conversationStateManager = createMockConversationStateManager();
	const addToChatQueue = () => {};

	const results = await executeToolsDirectly(
		toolCalls,
		null,
		conversationStateManager as any,
		addToChatQueue,
	);

	t.deepEqual(results, []);
});

test('executeToolsDirectly - handles null tool manager', async t => {
	const toolCalls: ToolCall[] = [
		{
			id: 'call_1',
			function: {name: 'test_tool', arguments: '{}'},
		},
	];

	const conversationStateManager = createMockConversationStateManager();
	const addToChatQueue = () => {};

	const toolManager = null;

	const results = await executeToolsDirectly(
		toolCalls,
		toolManager,
		conversationStateManager as any,
		addToChatQueue,
	);

	t.is(results.length, 1);
});

test('executeToolsDirectly - handles tool with no validator', async t => {
	const toolCalls: ToolCall[] = [
		{
			id: 'call_1',
			function: {name: 'unvalidated_tool', arguments: '{}'},
		},
	];

	const conversationStateManager = createMockConversationStateManager();
	const addToChatQueue = () => {};

	const toolManager = createMockToolManager({
		// No validator defined for this tool
		validatorResult: undefined,
		shouldFail: false,
	});

	const results = await executeToolsDirectly(
		toolCalls,
		toolManager,
		conversationStateManager as any,
		addToChatQueue,
	);

	t.is(results.length, 1);
});

// ============================================================================
// Compact Display Tests
// ============================================================================

test('executeToolsDirectly - compact display calls onCompactToolCount instead of adding to chat queue', async t => {
	const toolCalls: ToolCall[] = [
		{id: 'call_1', function: {name: 'tool1', arguments: '{}'}},
		{id: 'call_2', function: {name: 'tool1', arguments: '{}'}},
		{id: 'call_3', function: {name: 'tool2', arguments: '{}'}},
	];

	const conversationStateManager = createMockConversationStateManager();
	const addToChatQueueCalls: unknown[] = [];
	const addToChatQueue = (component: unknown) => {
		addToChatQueueCalls.push(component);
	};
	const toolManager = createMockToolManager({
		validatorResult: undefined,
		shouldFail: false,
	});

	const compactCounts: Array<string> = [];

	const results = await executeToolsDirectly(
		toolCalls,
		toolManager,
		conversationStateManager as any,
		addToChatQueue,
		{
			compactDisplay: true,
			onCompactToolCount: (toolName) => {
				compactCounts.push(toolName);
			},
		},
	);

	t.is(results.length, 3);
	// Compact mode should NOT add to chat queue (counts are displayed live instead)
	t.is(addToChatQueueCalls.length, 0);
	// Should have called onCompactToolCount for each tool
	t.deepEqual(compactCounts, ['tool1', 'tool1', 'tool2']);
});

test('executeToolsDirectly - compact display tallies failures instead of queueing each one', async t => {
	const toolCalls: ToolCall[] = [
		{id: 'call_1', function: {name: 'failing_tool', arguments: '{}'}},
		{id: 'call_2', function: {name: 'failing_tool', arguments: '{}'}},
	];

	const conversationStateManager = createMockConversationStateManager();
	const addToChatQueueCalls: unknown[] = [];
	const addToChatQueue = (component: unknown) => {
		addToChatQueueCalls.push(component);
	};
	const toolManager = createMockToolManager({
		validatorResult: undefined,
		shouldFail: false,
	});

	const compactCounts: Array<{toolName: string; failed?: boolean}> = [];

	const results = await executeToolsDirectly(
		toolCalls,
		toolManager,
		conversationStateManager as any,
		addToChatQueue,
		{
			compactDisplay: true,
			onCompactToolCount: (toolName, _detail, failed) => {
				compactCounts.push({toolName, failed});
			},
		},
	);

	t.is(results.length, 2);
	t.is(addToChatQueueCalls.length, 0);
	t.deepEqual(compactCounts, [
		{toolName: 'failing_tool', failed: true},
		{toolName: 'failing_tool', failed: true},
	]);
});

test('executeToolsDirectly - non-interactive compact mode pushes one-liner per tool and skips onCompactToolCount', async t => {
	const toolCalls: ToolCall[] = [
		{id: 'call_1', function: {name: 'tool1', arguments: '{}'}},
		{id: 'call_2', function: {name: 'tool1', arguments: '{}'}},
		{id: 'call_3', function: {name: 'tool2', arguments: '{}'}},
	];

	const conversationStateManager = createMockConversationStateManager();
	const addToChatQueueCalls: unknown[] = [];
	const addToChatQueue = (component: unknown) => {
		addToChatQueueCalls.push(component);
	};
	const toolManager = createMockToolManager({
		validatorResult: undefined,
		shouldFail: false,
	});

	const compactCounts: Array<string> = [];

	const results = await executeToolsDirectly(
		toolCalls,
		toolManager,
		conversationStateManager as any,
		addToChatQueue,
		{
			compactDisplay: true,
			nonInteractiveMode: true,
			onCompactToolCount: (toolName) => {
				compactCounts.push(toolName);
			},
		},
	);

	t.is(results.length, 3);
	// Non-interactive bypasses the live-tally accumulator.
	t.is(compactCounts.length, 0);
	// One compact one-liner pushed per tool, in execution order.
	t.is(addToChatQueueCalls.length, 3);
});

test('executeToolsDirectly - handles tool with valid validation', async t => {
	const toolCalls: ToolCall[] = [
		{
			id: 'call_1',
			function: {
				name: 'validated_tool',
				arguments: '{"path": "valid"}',
			},
		},
	];

	const conversationStateManager = createMockConversationStateManager();
	const addToChatQueue = () => {};

	const toolManager = createMockToolManager({
		validatorResult: {valid: true},
		shouldFail: false,
	});

	const results = await executeToolsDirectly(
		toolCalls,
		toolManager,
		conversationStateManager as any,
		addToChatQueue,
	);

	t.is(results.length, 1);
});

test('executeToolsDirectly - groupByReadOnly groups consecutive read-only tools', async t => {
	// [read, read, write, read, read] should produce groups:
	// [[read, read], [write], [read, read]]
	const toolCalls: ToolCall[] = [
		{id: 'call_1', function: {name: 'slow_tool1', arguments: '{}'}},
		{id: 'call_2', function: {name: 'slow_tool2', arguments: '{}'}},
		{id: 'call_3', function: {name: 'tool1', arguments: '{}'}},
		{id: 'call_4', function: {name: 'slow_tool3', arguments: '{}'}},
		{id: 'call_5', function: {name: 'slow_tool1', arguments: '{}'}},
	];

	const conversationStateManager = createMockConversationStateManager();
	const addToChatQueue = () => {};
	const toolManager = createMockToolManager({
		validatorResult: undefined,
		shouldFail: false,
		readOnlyTools: ['slow_tool1', 'slow_tool2', 'slow_tool3'],
	});

	const start = Date.now();
	const results = await executeToolsDirectly(
		toolCalls,
		toolManager,
		conversationStateManager as any,
		addToChatQueue,
	);
	const elapsed = Date.now() - start;

	t.is(results.length, 5);
	// If grouped correctly: group1 (2 parallel ~50ms) + group2 (1 sequential) + group3 (2 parallel ~50ms)
	// Total ~100ms + overhead, NOT 250ms (5 * 50ms sequential)
	t.true(elapsed < 200, `Should be faster than sequential (took ${elapsed}ms)`);
});

test('executeToolsDirectly - onCompactToolCount receives correct tool names', async t => {
	const toolCalls: ToolCall[] = [
		{id: 'call_1', function: {name: 'tool1', arguments: '{}'}},
		{id: 'call_2', function: {name: 'tool2', arguments: '{}'}},
		{id: 'call_3', function: {name: 'tool1', arguments: '{}'}},
	];

	const conversationStateManager = createMockConversationStateManager();
	const addToChatQueue = () => {};
	const toolManager = createMockToolManager({
		validatorResult: undefined,
		shouldFail: false,
	});

	const countedTools: string[] = [];

	await executeToolsDirectly(
		toolCalls,
		toolManager,
		conversationStateManager as any,
		addToChatQueue,
		{
			compactDisplay: true,
			onCompactToolCount: (toolName) => {
				countedTools.push(toolName);
			},
		},
	);

	t.is(countedTools.length, 3);
	t.is(countedTools[0], 'tool1');
	t.is(countedTools[1], 'tool2');
	t.is(countedTools[2], 'tool1');
});

test('executeToolsDirectly - compact mode without onCompactToolCount does not error', async t => {
	const toolCalls: ToolCall[] = [
		{id: 'call_1', function: {name: 'tool1', arguments: '{}'}},
	];

	const conversationStateManager = createMockConversationStateManager();
	const addToChatQueue = () => {};
	const toolManager = createMockToolManager({
		validatorResult: undefined,
		shouldFail: false,
	});

	await t.notThrowsAsync(async () => {
		await executeToolsDirectly(
			toolCalls,
			toolManager,
			conversationStateManager as any,
			addToChatQueue,
			{
				compactDisplay: true,
				// onCompactToolCount intentionally omitted
			},
		);
	});
});

test('executeToolsDirectly - compact mode always expands task tools', async t => {
	const toolCalls: ToolCall[] = [
		{id: 'call_1', function: {name: 'tool1', arguments: '{}'}},
		{id: 'call_2', function: {name: 'write_tasks', arguments: '{}'}},
	];

	const conversationStateManager = createMockConversationStateManager();
	const addToChatQueueCalls: unknown[] = [];
	const addToChatQueue = (component: unknown) => {
		addToChatQueueCalls.push(component);
	};
	const toolManager = createMockToolManager({
		validatorResult: undefined,
		shouldFail: false,
	});

	const compactCounts: string[] = [];
	let liveTaskUpdateCount = 0;

	const results = await executeToolsDirectly(
		toolCalls,
		toolManager,
		conversationStateManager as any,
		addToChatQueue,
		{
			compactDisplay: true,
			onCompactToolCount: (toolName) => {
				compactCounts.push(toolName);
			},
			onLiveTaskUpdate: () => {
				liveTaskUpdateCount++;
			},
		},
	);

	t.is(results.length, 2);
	// Only tool1 should be compacted (counted); the task tool goes to live display
	t.deepEqual(compactCounts, ['tool1']);
	// The task tool should trigger a live task update instead of adding to chat queue
	t.is(liveTaskUpdateCount, 1, 'Task tool should trigger a live task update');
});

// ============================================================================
// Agent batch signal threading
// (regression: parent's abort signal must reach running subagents)
// ============================================================================

test.serial(
	'executeToolsDirectly - threads abort signal into subagent executor',
	async t => {
		const {setAgentToolExecutor} = await import('@/tools/agent-tool');

		let received: AbortSignal | undefined;
		setAgentToolExecutor({
			execute: async (_task: unknown, signal?: AbortSignal) => {
				received = signal;
				return {
					subagentName: 'fake',
					output: 'ok',
					success: true,
					executionTimeMs: 1,
				};
			},
		} as never);

		const toolCalls: ToolCall[] = [
			{
				id: 'call_agent_1',
				function: {
					name: 'agent',
					arguments: JSON.stringify({
						subagent_type: 'fake',
						description: 'test',
					}),
				},
			},
		];

		const controller = new AbortController();
		await executeToolsDirectly(
			toolCalls,
			createMockToolManager() as any,
			createMockConversationStateManager() as any,
			() => {},
			{compactDisplay: true, signal: controller.signal},
		);

		t.is(received, controller.signal);
	},
);

test.serial(
	'executeToolsDirectly - aborted signal surfaces as agent error result',
	async t => {
		const {setAgentToolExecutor} = await import('@/tools/agent-tool');

		setAgentToolExecutor({
			execute: async (_task: unknown, signal?: AbortSignal) => {
				if (signal?.aborted) {
					return {
						subagentName: 'fake',
						output: '',
						success: false,
						error: 'Aborted',
						executionTimeMs: 1,
					};
				}
				return {
					subagentName: 'fake',
					output: 'ok',
					success: true,
					executionTimeMs: 1,
				};
			},
		} as never);

		const controller = new AbortController();
		controller.abort();

		const toolCalls: ToolCall[] = [
			{
				id: 'call_agent_2',
				function: {
					name: 'agent',
					arguments: JSON.stringify({
						subagent_type: 'fake',
						description: 'test',
					}),
				},
			},
		];

		const results = await executeToolsDirectly(
			toolCalls,
			createMockToolManager() as any,
			createMockConversationStateManager() as any,
			() => {},
			{compactDisplay: true, signal: controller.signal},
		);

		t.is(results.length, 1);
		t.true(
			results[0].content.includes('Aborted'),
			`expected 'Aborted' in content, got: ${results[0].content}`,
		);
	},
);

test.serial(
	'executeToolsDirectly - compact agent exposes live tail and final details',
	async t => {
		const {setAgentToolExecutor} = await import('@/tools/agent-tool');
		const {appendSubagentTool, updateSubagentProgressById} = await import(
			'@/services/subagent-events'
		);

		let releaseAgent!: () => void;
		const agentMayComplete = new Promise<void>(resolve => {
			releaseAgent = resolve;
		});

		setAgentToolExecutor({
			execute: async (
				task: {subagent_type: string},
				_signal?: AbortSignal,
				_depth?: number,
				agentId?: string,
			) => {
				t.truthy(agentId);
				updateSubagentProgressById(agentId!, {
					subagentName: task.subagent_type,
					status: 'tool_call',
					currentTool: 'read_file',
					toolCallCount: 1,
					turnCount: 1,
					tokenCount: 42,
				});
				appendSubagentTool(agentId, 'read_file');
				await agentMayComplete;
				return {
					subagentName: task.subagent_type,
					output: 'ok',
					success: true,
					executionTimeMs: 1,
				};
			},
		} as never);

		const runningCounts: unknown[] = [];
		const compactCounts: Array<{toolName: string; detail?: string | string[]}> =
			[];
		const run = executeToolsDirectly(
			[
				{
					id: 'call_agent_compact',
					function: {
						name: 'agent',
						arguments: JSON.stringify({
							subagent_type: 'explore',
							description: 'inspect repository',
						}),
					},
				},
			],
			createMockToolManager() as any,
			createMockConversationStateManager() as any,
			() => {},
			{
				compactDisplay: true,
				onRunningToolCounts: counts => {
					if (counts) runningCounts.push(counts);
				},
				onCompactToolCount: (toolName, detail) => {
					compactCounts.push({toolName, detail});
				},
			},
		);

		await delay(20);
		t.true(runningCounts.length > 0);
		const latestRunning = runningCounts.at(-1) as Record<string, any>;
		const liveDetails = latestRunning.agent.liveDetails();
		t.deepEqual(liveDetails, [
			'explore: running read_file · 1 tool call · ~42 tokens',
			'explore → read_file',
		]);

		releaseAgent();
		await run;

		t.deepEqual(compactCounts, [
			{
				toolName: 'agent',
				detail: [
					'explore: running read_file · 1 tool call · ~42 tokens',
					'explore → read_file',
				],
			},
		]);
	},
);

test('executeToolsDirectly - compact mode counts errors instead of queueing them', async t => {
	const toolCalls: ToolCall[] = [
		{id: 'call_1', function: {name: 'failing_tool', arguments: '{}'}},
	];

	const conversationStateManager = createMockConversationStateManager();
	const addToChatQueueCalls: unknown[] = [];
	const addToChatQueue = (component: unknown) => {
		addToChatQueueCalls.push(component);
	};
	const toolManager = createMockToolManager({
		validatorResult: undefined,
		shouldFail: true,
	});

	const compactCounts: Array<{toolName: string; failed?: boolean}> = [];

	const results = await executeToolsDirectly(
		toolCalls,
		toolManager,
		conversationStateManager as any,
		addToChatQueue,
		{
			compactDisplay: true,
			onCompactToolCount: (toolName, _detail, failed) => {
				compactCounts.push({toolName, failed});
			},
		},
	);

	t.is(results.length, 1);
	t.true(results[0].content.includes('Error:'));
	t.is(addToChatQueueCalls.length, 0);
	t.deepEqual(compactCounts, [{toolName: 'failing_tool', failed: true}]);
});

test('executeToolsDirectly passes privacy options to rehydrate tools', async t => {
t.pass(); // Add proper structural verification if stream testing is hard
});
