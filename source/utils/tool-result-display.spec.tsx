import test from 'ava';
import React from 'react';
import {ErrorMessage} from '../components/message-box.js';
import ToolMessage from '../components/tool-message.js';
import type {ToolManager} from '../tools/tool-manager.js';
import type {ToolCall, ToolResult} from '../types/core.js';
import {renderWithTheme} from '../test-utils/render-with-theme.js';
import {
	CompactToolCountsLine,
	LiveCompactCounts,
	displayCompactCountsSummary,
	displayToolResult,
	getLiveCompactToolExpandHitboxColumns,
} from './tool-result-display.js';

// ============================================================================
// Type Definitions
// ============================================================================

interface ErrorMessageProps {
	message: string;
	hideTitle?: boolean;
	hideBox?: boolean;
}

interface ToolMessageProps {
	title?: string;
	message: string | React.ReactNode;
	hideTitle?: boolean;
	hideBox?: boolean;
	isBashMode?: boolean;
}

// ============================================================================
// Test Helpers
// ============================================================================

// Helper to create mock tool calls
function createMockToolCall(
	id: string,
	name: string,
	args: Record<string, unknown> = {},
): ToolCall {
	return {
		id,
		function: {
			name,
			arguments: args,
		},
	};
}

// Helper to create mock tool results
function createMockToolResult(
	toolCallId: string,
	name: string,
	content: string,
): ToolResult {
	return {
		tool_call_id: toolCallId,
		role: 'tool',
		name,
		content,
	};
}

// Mock addToChatQueue function
function createMockAddToChatQueue() {
	const queue: React.ReactNode[] = [];
	const addToChatQueue = (component: React.ReactNode) => {
		queue.push(component);
	};
	return {addToChatQueue, queue};
}

// Mock ToolManager
class MockToolManager implements Partial<ToolManager> {
	private formatters: Map<string, (args: unknown, content: string) => unknown>;

	constructor() {
		this.formatters = new Map();
	}

	registerFormatter(
		toolName: string,
		formatter: (args: unknown, content: string) => unknown,
	) {
		this.formatters.set(toolName, formatter);
	}

	getToolFormatter(toolName: string) {
		return this.formatters.get(toolName);
	}
}

// Helper to safely cast MockToolManager to ToolManager for tests
function asMockToolManager(mock: MockToolManager): ToolManager {
	return mock as unknown as ToolManager;
}

// ============================================================================
// Tests for Error Display
// ============================================================================

test('displayToolResult - displays error message for error result', async t => {
	const toolCall = createMockToolCall('call-1', 'TestTool');
	const result = createMockToolResult(
		'call-1',
		'TestTool',
		'Error: Something went wrong',
	);
	const {addToChatQueue, queue} = createMockAddToChatQueue();

	await displayToolResult(toolCall, result, null, addToChatQueue);

	t.is(queue.length, 1);
	t.true(React.isValidElement(queue[0]));
	// Check that error component was created (ErrorMessage component)
	const element = queue[0] as React.ReactElement;
	t.is(element.type, ErrorMessage);
});

test('displayToolResult - renders a validation failure as a red error', async t => {
	const toolCall = createMockToolCall('call-1', 'TestTool');
	const result = createMockToolResult(
		'call-1',
		'TestTool',
		'⚒ Validation failed: one or more arguments have the wrong type\n  - `path`: expected string, received object',
	);
	const {addToChatQueue, queue} = createMockAddToChatQueue();

	await displayToolResult(toolCall, result, null, addToChatQueue);

	t.is(queue.length, 1);
	const element = queue[0] as React.ReactElement<ErrorMessageProps>;
	t.is(element.type, ErrorMessage);
	// Full validation message is preserved (not stripped) so the field detail shows.
	t.regex(element.props.message, /Validation failed/);
	t.regex(element.props.message, /expected string, received object/);
});

test('displayToolResult - compact mode condenses an error to a one-liner', async t => {
	const toolCall = createMockToolCall('call-1', 'write_file');
	const result = createMockToolResult(
		'call-1',
		'write_file',
		'Error: Something went wrong with a very long verbose explanation',
	);
	const {addToChatQueue, queue} = createMockAddToChatQueue();

	await displayToolResult(toolCall, result, null, addToChatQueue, true);

	t.is(queue.length, 1);
	const {lastFrame, unmount} = renderWithTheme(
		queue[0] as React.ReactElement,
	);
	const output = lastFrame();
	t.regex(output!, /Write failed/);
	t.notRegex(output!, /verbose explanation/);
	unmount();
});

test('displayToolResult - compact mode condenses a validation failure too', async t => {
	const toolCall = createMockToolCall('call-1', 'write_file');
	const result = createMockToolResult(
		'call-1',
		'write_file',
		'⚒ Validation failed: Invalid file path: "/abs/path". Path must be relative.',
	);
	const {addToChatQueue, queue} = createMockAddToChatQueue();

	await displayToolResult(toolCall, result, null, addToChatQueue, true);

	t.is(queue.length, 1);
	const {lastFrame, unmount} = renderWithTheme(
		queue[0] as React.ReactElement,
	);
	const output = lastFrame();
	t.regex(output!, /Write failed/);
	t.notRegex(output!, /Invalid file path/);
	unmount();
});

test('LiveCompactCounts renders running state and groups failed tools', t => {
	const {lastFrame, unmount} = renderWithTheme(
		<LiveCompactCounts
			counts={{
				fetch_url: {count: 10, failed: true, running: true},
			}}
		/>,
	);

	const output = lastFrame()!;
	t.regex(output, /^⚒\s+Ran WebFetch ×10 failed \(running\) \(ctrl-o to expand\)/);
	t.notRegex(output, /Running WebFetch/);
	unmount();
});

test('CompactToolCountsLine renders completed failed summaries as ran', t => {
	const {lastFrame, unmount} = renderWithTheme(
		<CompactToolCountsLine
			entries={[['fetch_url', {count: 10, failed: true}]]}
		/>,
	);

	const output = lastFrame()!;
	t.regex(output, /^⚒\s+Ran WebFetch ×10 failed/);
	t.notRegex(output, /^ ⚒/);
	unmount();
});

test('displayToolResult - omnicode compact agent renders subagent detail in parentheses', async t => {
	const toolCall = createMockToolCall('call-agent', 'agent', {
		subagent_type: 'explore',
		description: 'inspect auth flow',
	});
	const result = createMockToolResult('call-agent', 'agent', 'done');
	const {addToChatQueue, queue} = createMockAddToChatQueue();

	await displayToolResult(toolCall, result, null, addToChatQueue, true, {
		iconTheme: true,
	});

	t.is(queue.length, 1);
	const {lastFrame, unmount} = renderWithTheme(
		queue[0] as React.ReactElement,
	);
	const output = lastFrame();
	t.regex(output!, /Task\(explore: inspect auth flow\)/);
	unmount();
});

test('displayToolResult - non-compact error still shows full message', async t => {
	const toolCall = createMockToolCall('call-1', 'write_file');
	const result = createMockToolResult(
		'call-1',
		'write_file',
		'Error: Something went wrong with a very long verbose explanation',
	);
	const {addToChatQueue, queue} = createMockAddToChatQueue();

	await displayToolResult(toolCall, result, null, addToChatQueue);

	t.is(queue.length, 1);
	const element = queue[0] as React.ReactElement<ErrorMessageProps>;
	t.is(element.type, ErrorMessage);
	t.regex(element.props.message, /verbose explanation/);
});

test('displayToolResult - strips "Error: " prefix from error message', async t => {
	const toolCall = createMockToolCall('call-1', 'TestTool');
	const result = createMockToolResult(
		'call-1',
		'TestTool',
		'Error: File not found',
	);
	const {addToChatQueue, queue} = createMockAddToChatQueue();

	await displayToolResult(toolCall, result, null, addToChatQueue);

	const element = queue[0] as React.ReactElement<ErrorMessageProps>;
	t.is(element.props.message, 'File not found');
});

test('displayToolResult - sets hideBox to true for error message', async t => {
	const toolCall = createMockToolCall('call-1', 'TestTool');
	const result = createMockToolResult(
		'call-1',
		'TestTool',
		'Error: Test error',
	);
	const {addToChatQueue, queue} = createMockAddToChatQueue();

	await displayToolResult(toolCall, result, null, addToChatQueue);

	const element = queue[0] as React.ReactElement<ErrorMessageProps>;
	t.is(element.props.hideBox, true);
});

// ============================================================================
// Tests for No ToolManager (Silent Return)
// ============================================================================

test('displayToolResult - returns silently when toolManager is null and no error', async t => {
	const toolCall = createMockToolCall('call-1', 'TestTool');
	const result = createMockToolResult('call-1', 'TestTool', 'Success result');
	const {addToChatQueue, queue} = createMockAddToChatQueue();

	await displayToolResult(toolCall, result, null, addToChatQueue);

	// With null toolManager and no error, function returns without adding to queue
	t.is(queue.length, 0);
});

// ============================================================================
// Tests for Formatter Execution
// ============================================================================

test('displayToolResult - uses formatter when available', async t => {
	const toolCall = createMockToolCall('call-1', 'ReadFile', {path: '/test'});
	const result = createMockToolResult('call-1', 'ReadFile', 'file contents');
	const {addToChatQueue, queue} = createMockAddToChatQueue();

	const toolManager = new MockToolManager();
	let formatterCalled = false;
	toolManager.registerFormatter('ReadFile', (_args, content) => {
		formatterCalled = true;
		return `Formatted: ${content}`;
	});

	await displayToolResult(
		toolCall,
		result,
		asMockToolManager(toolManager),
		addToChatQueue,
	);

	t.true(formatterCalled);
	t.is(queue.length, 1);
});

test('displayToolResult - displays formatted result as ToolMessage when formatter returns string', async t => {
	const toolCall = createMockToolCall('call-1', 'ReadFile', {path: '/test'});
	const result = createMockToolResult('call-1', 'ReadFile', 'raw content');
	const {addToChatQueue, queue} = createMockAddToChatQueue();

	const toolManager = new MockToolManager();
	toolManager.registerFormatter('ReadFile', () => 'Formatted content');

	await displayToolResult(
		toolCall,
		result,
		asMockToolManager(toolManager),
		addToChatQueue,
	);

	const element = queue[0] as React.ReactElement<ToolMessageProps>;
	t.is(element.type, ToolMessage);
	t.is(element.props.message, 'Formatted content');
	t.is(element.props.title, '⚒ ReadFile');
});

test('displayToolResult - clones React element when formatter returns element', async t => {
	const toolCall = createMockToolCall('call-1', 'CustomTool');
	const result = createMockToolResult('call-1', 'CustomTool', 'data');
	const {addToChatQueue, queue} = createMockAddToChatQueue();

	const customElement = <div>Custom formatted result</div>;
	const toolManager = new MockToolManager();
	toolManager.registerFormatter('CustomTool', () => customElement);

	await displayToolResult(
		toolCall,
		result,
		asMockToolManager(toolManager),
		addToChatQueue,
	);

	t.is(queue.length, 1);
	t.true(React.isValidElement(queue[0]));
	const element = queue[0] as React.ReactElement;
	t.truthy(element.key); // Should have a key added
});

test('displayToolResult - falls back to raw result when formatter throws', async t => {
	const toolCall = createMockToolCall('call-1', 'BrokenTool');
	const result = createMockToolResult('call-1', 'BrokenTool', 'raw result');
	const {addToChatQueue, queue} = createMockAddToChatQueue();

	const toolManager = new MockToolManager();
	toolManager.registerFormatter('BrokenTool', () => {
		throw new Error('Formatter error');
	});

	await displayToolResult(
		toolCall,
		result,
		asMockToolManager(toolManager),
		addToChatQueue,
	);

	t.is(queue.length, 1);
	const element = queue[0] as React.ReactElement<ToolMessageProps>;
	t.is(element.props.message, 'raw result');
	t.is(element.props.title, '⚒ BrokenTool');
});

test('displayToolResult - displays raw result when no formatter exists', async t => {
	const toolCall = createMockToolCall('call-1', 'NoFormatterTool');
	const result = createMockToolResult(
		'call-1',
		'NoFormatterTool',
		'raw content',
	);
	const {addToChatQueue, queue} = createMockAddToChatQueue();

	const toolManager = new MockToolManager();
	// Don't register any formatter

	await displayToolResult(
		toolCall,
		result,
		asMockToolManager(toolManager),
		addToChatQueue,
	);

	t.is(queue.length, 1);
	const element = queue[0] as React.ReactElement<ToolMessageProps>;
	t.is(element.props.message, 'raw content');
	t.is(element.props.title, '⚒ NoFormatterTool');
});

// ============================================================================
// Tests for Argument Parsing
// ============================================================================

test('displayToolResult - parses string arguments before passing to formatter', async t => {
	const toolCall = createMockToolCall('call-1', 'TestTool', {
		path: '/test',
	});
	const result = createMockToolResult('call-1', 'TestTool', 'result');
	const {addToChatQueue} = createMockAddToChatQueue();

	let receivedArgs: unknown;
	const toolManager = new MockToolManager();
	toolManager.registerFormatter('TestTool', (args, content) => {
		receivedArgs = args;
		return content;
	});

	await displayToolResult(
		toolCall,
		result,
		asMockToolManager(toolManager),
		addToChatQueue,
	);

	t.deepEqual(receivedArgs, {path: '/test'});
});

test('displayToolResult - passes object arguments directly to formatter', async t => {
	const args = {path: '/test', recursive: true};
	const toolCall = createMockToolCall('call-1', 'TestTool', args);
	const result = createMockToolResult('call-1', 'TestTool', 'result');
	const {addToChatQueue} = createMockAddToChatQueue();

	let receivedArgs: unknown;
	const toolManager = new MockToolManager();
	toolManager.registerFormatter('TestTool', (args, content) => {
		receivedArgs = args;
		return content;
	});

	await displayToolResult(
		toolCall,
		result,
		asMockToolManager(toolManager),
		addToChatQueue,
	);

	t.deepEqual(receivedArgs, args);
});

// ============================================================================
// Tests for Key Generation
// ============================================================================

test('displayToolResult - generates unique keys for successive calls', async t => {
	const toolCall = createMockToolCall('call-1', 'TestTool');
	const result = createMockToolResult('call-1', 'TestTool', 'result');
	const {addToChatQueue, queue} = createMockAddToChatQueue();

	const toolManager = new MockToolManager();

	// Each call should produce a unique key from the shared key generator
	await displayToolResult(
		toolCall,
		result,
		asMockToolManager(toolManager),
		addToChatQueue,
	);
	await displayToolResult(
		toolCall,
		result,
		asMockToolManager(toolManager),
		addToChatQueue,
	);

	t.is(queue.length, 2);
	const element1 = queue[0] as React.ReactElement;
	const element2 = queue[1] as React.ReactElement;
	t.not(element1.key, element2.key);
});

test('displayToolResult - includes tool_call_id in key', async t => {
	const toolCall1 = createMockToolCall('call-1', 'TestTool');
	const result1 = createMockToolResult('call-1', 'TestTool', 'result');
	const toolCall2 = createMockToolCall('call-2', 'TestTool');
	const result2 = createMockToolResult('call-2', 'TestTool', 'result');
	const {addToChatQueue, queue} = createMockAddToChatQueue();

	const toolManager = new MockToolManager();

	await displayToolResult(
		toolCall1,
		result1,
		asMockToolManager(toolManager),
		addToChatQueue,
	);
	await displayToolResult(
		toolCall2,
		result2,
		asMockToolManager(toolManager),
		addToChatQueue,
	);

	t.is(queue.length, 2);
	const element1 = queue[0] as React.ReactElement;
	const element2 = queue[1] as React.ReactElement;
	t.not(element1.key, element2.key);
	// The keys should reference different tool call ids
	t.regex(element1.key as string, /call-1/);
	t.regex(element2.key as string, /call-2/);
});

// ============================================================================
// Tests for hideBox Property
// ============================================================================

test('displayToolResult - sets hideBox to true for all ToolMessage displays', async t => {
	const toolCall = createMockToolCall('call-1', 'TestTool');
	const result = createMockToolResult('call-1', 'TestTool', 'result');
	const {addToChatQueue, queue} = createMockAddToChatQueue();

	const toolManager = new MockToolManager();

	await displayToolResult(
		toolCall,
		result,
		asMockToolManager(toolManager),
		addToChatQueue,
	);

	const element = queue[0] as React.ReactElement<ToolMessageProps>;
	t.is(element.props.hideBox, true);
});

// ============================================================================
// Real-World Scenario Tests
// ============================================================================

test('displayToolResult - handles complex multi-tool scenario', async t => {
	const {addToChatQueue, queue} = createMockAddToChatQueue();
	const toolManager = new MockToolManager();

	// Register formatters for different tools
	toolManager.registerFormatter('ReadFile', (args: any) => (
		<div>Read {args.path}</div>
	));
	toolManager.registerFormatter('ExecuteBash', (_, content) => (
		<div>Bash: {content}</div>
	));

	// Execute multiple tool results
	await displayToolResult(
		createMockToolCall('call-1', 'ReadFile', {path: '/test.txt'}),
		createMockToolResult('call-1', 'ReadFile', 'file contents'),
		asMockToolManager(toolManager),
		addToChatQueue,
	);

	await displayToolResult(
		createMockToolCall('call-2', 'ExecuteBash', {command: 'ls'}),
		createMockToolResult('call-2', 'ExecuteBash', 'file1\nfile2'),
		asMockToolManager(toolManager),
		addToChatQueue,
	);

	await displayToolResult(
		createMockToolCall('call-3', 'ToolWithoutFormatter'),
		createMockToolResult('call-3', 'ToolWithoutFormatter', 'raw output'),
		asMockToolManager(toolManager),
		addToChatQueue,
	);

	t.is(queue.length, 3);
	// All should be valid React elements
	queue.forEach(item => {
		t.true(React.isValidElement(item));
	});
});

// ============================================================================
// Tests for Compact Display Mode
// ============================================================================

test('displayToolResult - compact mode adds single compact element to queue', async t => {
	const toolCall = createMockToolCall('call-1', 'read_file', {path: '/test'});
	const result = createMockToolResult('call-1', 'read_file', 'file contents');
	const {addToChatQueue, queue} = createMockAddToChatQueue();

	await displayToolResult(
		toolCall,
		result,
		null,
		addToChatQueue,
		true, // compact
	);

	t.is(queue.length, 1);
	t.true(React.isValidElement(queue[0]));
});

test('displayToolResult - compact mode condenses errors to a one-liner', async t => {
	const toolCall = createMockToolCall('call-1', 'read_file');
	const result = createMockToolResult(
		'call-1',
		'read_file',
		'Error: File not found',
	);
	const {addToChatQueue, queue} = createMockAddToChatQueue();

	await displayToolResult(
		toolCall,
		result,
		null,
		addToChatQueue,
		true, // compact
	);

	t.is(queue.length, 1);
	const {lastFrame, unmount} = renderWithTheme(
		queue[0] as React.ReactElement,
	);
	const output = lastFrame();
	t.regex(output!, /Read failed/);
	t.notRegex(output!, /File not found/);
	unmount();
});

// ============================================================================
// Tests for displayCompactCountsSummary
// ============================================================================

test('displayCompactCountsSummary - adds single wrapper element for all tool types', t => {
	const {addToChatQueue, queue} = createMockAddToChatQueue();

	displayCompactCountsSummary(
		{read_file: 5, search_file_contents: 2},
		addToChatQueue,
	);

	t.is(queue.length, 1);
});

test('displayCompactCountsSummary - handles single tool type', t => {
	const {addToChatQueue, queue} = createMockAddToChatQueue();

	displayCompactCountsSummary(
		{read_file: 3},
		addToChatQueue,
	);

	t.is(queue.length, 1);
});

test('displayCompactCountsSummary - handles empty counts', t => {
	const {addToChatQueue, queue} = createMockAddToChatQueue();

	displayCompactCountsSummary(
		{},
		addToChatQueue,
	);

	t.is(queue.length, 0);
});

// ============================================================================
// LiveCompactCounts Component Tests
// ============================================================================

test('LiveCompactCounts - renders tool counts', t => {
	const {lastFrame, unmount} = renderWithTheme(
		<LiveCompactCounts
			counts={{
				read_file: {count: 3, running: true},
				search_file_contents: {count: 2, running: true},
			}}
		/>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Ran Read ×3 and Grep ×2 \(running\)/);
	t.regex(output!, /\(ctrl-o to expand\)/);
	unmount();
});

test('LiveCompactCounts - renders single count without multiplier', t => {
	const {lastFrame, unmount} = renderWithTheme(
		<LiveCompactCounts
			counts={{write_file: {count: 1, detail: 'notes.md', running: true}}}
		/>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Write\(notes\.md\)/);
	t.notRegex(output!, /×1/);
	unmount();
});

test('LiveCompactCounts - collapses repeated detailed calls to multiplier', t => {
	const {lastFrame, unmount} = renderWithTheme(
		<LiveCompactCounts
			counts={{execute_bash: {count: 2, detail: 'echo latest', running: true}}}
		/>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Bash ×2/);
	t.notRegex(output!, /echo latest/);
	unmount();
});

test('LiveCompactCounts - merges completed and running compact counts', t => {
	const {lastFrame, unmount} = renderWithTheme(
		<LiveCompactCounts
			counts={{
				execute_bash: {count: 2},
				'execute_bash:running': {
					count: 1,
					details: ['gh repo list llupRisinglll --limit 100 --json name'],
					running: true,
				},
			}}
		/>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Ran Bash ×3 \(running\)/);
	t.regex(output!, /\(ctrl-o to expand\)/);
	t.regex(output!, /└\s+gh repo list llupRisinglll --limit 100 --json name/);
	t.notRegex(output!, /source\/app\/App\.tsx/);
	t.notRegex(output!, /Running Bash/);
	unmount();
});

test('LiveCompactCounts - renders live detail tails for running compact groups', t => {
	const {lastFrame, unmount} = renderWithTheme(
		<LiveCompactCounts
			counts={{
				agent: {
					count: 1,
					details: ['explore: inspect repository'],
					liveDetails: () => ['explore: running read_file'],
					running: true,
				},
			}}
		/>,
	);

	let output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Ran Task \(running\)/);
	t.regex(output!, /└\s+explore: inspect repository/);
	t.regex(output!, /explore: running read_file/);
	unmount();
});

test('LiveCompactCounts - truncates grouped running details and reports hidden commands', t => {
	const {lastFrame, unmount} = renderWithTheme(
		<LiveCompactCounts
			counts={{
				execute_bash: {
					count: 5,
					details: [
						'command one',
						'command two',
						'command three',
						'command four',
						'command five',
					],
					running: true,
				},
			}}
		/>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Ran Bash ×5 \(running\)/);
	t.notRegex(output!, /command one/);
	t.regex(output!, /command three/);
	t.regex(output!, /command four/);
	t.regex(output!, /command five/);
	t.regex(output!, /… \+2 more commands/);
	unmount();
});

test('LiveCompactCounts - expanded mode shows all grouped details', t => {
	const {lastFrame, unmount} = renderWithTheme(
		<LiveCompactCounts
			expanded={true}
			counts={{
				execute_bash: {
					count: 4,
					details: ['command one', 'command two', 'command three', 'command four'],
					running: true,
				},
			}}
		/>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /command one/);
	t.regex(output!, /command four/);
	t.notRegex(output!, /more commands/);
	t.regex(output!, /\(ctrl-o to collapse\)/);
	unmount();
});

test('LiveCompactCounts - hover highlights expand hint', t => {
	const {lastFrame, unmount} = renderWithTheme(
		<LiveCompactCounts
			expandHintHovered={true}
			counts={{
				execute_bash: {count: 2, details: ['command one'], running: true},
			}}
		/>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /\(ctrl-o to expand\)/);
	unmount();
});

test('getLiveCompactToolExpandHitboxColumns returns visible hint columns', t => {
	const hitbox = getLiveCompactToolExpandHitboxColumns(
		{
			execute_bash: {count: 2, running: true},
		},
		false,
	);

	t.truthy(hitbox);
	t.true(hitbox!.start > '⚒  Ran Bash ×2 (running)'.length);
	t.is(hitbox!.end - hitbox!.start + 1, '(ctrl-o to expand)'.length);
});

test('displayCompactCountsSummary - keeps safe compact details below summary', t => {
	const components: React.ReactNode[] = [];
	displayCompactCountsSummary(
		{
			execute_bash: {
				count: 2,
				details: ['first command', 'last command'],
			},
		},
		component => {
			components.push(component);
		},
		{expanded: true, indent: false},
	);

	const {lastFrame, unmount} = renderWithTheme(<>{components}</>);
	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Ran Bash ×2/);
	t.regex(output!, /\(ctrl-o to collapse\)/);
	t.regex(output!, /└\s+first command/);
	t.regex(output!, /last command/);
	unmount();
});

test('LiveCompactCounts - renders empty counts without error', t => {
	const {lastFrame, unmount} = renderWithTheme(
		<LiveCompactCounts counts={{}} />,
	);

	// Empty counts renders nothing - should not throw
	t.notThrows(() => lastFrame());
	unmount();
});

test('LiveCompactCounts - renders a single hammer for grouped entries', t => {
	const {lastFrame, unmount} = renderWithTheme(
		<LiveCompactCounts
			counts={{
				read_file: {count: 1, running: true},
				execute_bash: {count: 2, running: true},
			}}
		/>,
	);

	const output = lastFrame();
	t.truthy(output);
	const hammerCount = (output!.match(/\u2692/g) || []).length;
	t.is(hammerCount, 1);
	t.regex(output!, /Ran Read and Bash ×2 \(running\)/);
	unmount();
});

// ============================================================================
// Compact Description Mapping Tests (via displayToolResult compact mode)
// ============================================================================

test('displayToolResult compact - read_file shows compact tool name', async t => {
	const {addToChatQueue, queue} = createMockAddToChatQueue();
	const toolCall = createMockToolCall('1', 'read_file', {path: '/test.ts'});
	const result = createMockToolResult('1', 'read_file', 'file contents');

	await displayToolResult(toolCall, result, null, addToChatQueue, true);

	t.is(queue.length, 1);
	const {lastFrame, unmount} = renderWithTheme(
		queue[0] as React.ReactElement,
	);
	t.regex(lastFrame()!, /Read/);
	unmount();
});

test('displayToolResult compact - execute_bash shows command detail for icon theme', async t => {
	const {addToChatQueue, queue} = createMockAddToChatQueue();
	const toolCall = createMockToolCall('1', 'execute_bash', {command: 'ls'});
	const result = createMockToolResult('1', 'execute_bash', 'output');

	await displayToolResult(toolCall, result, null, addToChatQueue, true, {
		iconTheme: true,
	});

	t.is(queue.length, 1);
	const {lastFrame, unmount} = renderWithTheme(
		queue[0] as React.ReactElement,
	);
	const output = lastFrame();
	t.regex(output!, /Bash\(ls\)/);
	t.notRegex(output!, /Ran/);
	unmount();
});

test('displayToolResult compact - unknown tool uses tool name', async t => {
	const {addToChatQueue, queue} = createMockAddToChatQueue();
	const toolCall = createMockToolCall('1', 'custom_mcp_tool', {});
	const result = createMockToolResult('1', 'custom_mcp_tool', 'output');

	await displayToolResult(toolCall, result, null, addToChatQueue, true);

	t.is(queue.length, 1);
	const {lastFrame, unmount} = renderWithTheme(
		queue[0] as React.ReactElement,
	);
	t.regex(lastFrame()!, /custom_mcp_tool/);
	unmount();
});
