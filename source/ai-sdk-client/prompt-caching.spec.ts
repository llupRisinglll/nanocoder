import test from 'ava';
import type {ModelMessage} from 'ai';
import type {AISDKCoreTool} from '@/types/index';
import {
	ANTHROPIC_BREAKPOINT_CAP,
	applyCachePolicy,
	applyMessageCaching,
	buildCachedSystemMessages,
	countBreakpoints,
	newBreakpoints,
	providerSupportsCaching,
	type SystemPromptBlock,
} from './prompt-caching.js';

// ============================================================================
// providerSupportsCaching
// ============================================================================

test('providerSupportsCaching - only anthropic returns true', t => {
	t.true(providerSupportsCaching('anthropic'));
	t.false(providerSupportsCaching('openai-compatible'));
	t.false(providerSupportsCaching('github-copilot'));
	t.false(providerSupportsCaching('chatgpt-codex'));
	t.false(providerSupportsCaching('google'));
});

// ============================================================================
// newBreakpoints / budget
// ============================================================================

test('newBreakpoints - initializes with cap and zero dropped', t => {
	const bp = newBreakpoints(4);
	t.is(bp.remaining, 4);
	t.is(bp.dropped, 0);
});

test('ANTHROPIC_BREAKPOINT_CAP is 4', t => {
	t.is(ANTHROPIC_BREAKPOINT_CAP, 4);
});

// ============================================================================
// applyCachePolicy — no-op for non-Anthropic providers
// ============================================================================

test('applyCachePolicy - no-op for openai-compatible', t => {
	const blocks: SystemPromptBlock[] = [
		{text: 'stable', cacheScope: 'stable'},
	];
	const messages: ModelMessage[] = [
		{role: 'user', content: 'hello'},
	];
	const tools = {read_file: {} as AISDKCoreTool};
	const result = applyCachePolicy(blocks, messages, tools, 'openai-compatible');
	t.is(result.system, undefined);
	t.is(result.messages, messages);
	t.is(result.tools, tools);
	t.is(result.dropped, 0);
});

test('applyCachePolicy - no-op for chatgpt-codex', t => {
	const messages: ModelMessage[] = [{role: 'user', content: 'hi'}];
	const result = applyCachePolicy(undefined, messages, undefined, 'chatgpt-codex');
	t.is(result.system, undefined);
	t.is(result.messages, messages);
	t.is(result.dropped, 0);
});

// ============================================================================
// applyCachePolicy — marks tools + system + latest user message for Anthropic
// ============================================================================

test('applyCachePolicy - Anthropic: stamps last tool definition', t => {
	const tools = {
		read_file: {description: 'a'} as AISDKCoreTool,
		write_file: {description: 'b'} as AISDKCoreTool,
	};
	const result = applyCachePolicy(undefined, [], tools, 'anthropic');
	t.truthy(result.tools);
	t.deepEqual(result.tools!.read_file, tools.read_file);
	t.truthy(result.tools!.write_file.providerOptions?.anthropic?.cacheControl);
});

test('applyCachePolicy - Anthropic: stamps last stable system block only', t => {
	const blocks: SystemPromptBlock[] = [
		{text: 'identity', cacheScope: 'stable'},
		{text: 'cwd: /tmp', cacheScope: 'volatile'},
	];
	const result = applyCachePolicy(blocks, [], undefined, 'anthropic');
	t.truthy(result.system);
	t.is(result.system!.length, 2);
	t.truthy(result.system![0].providerOptions?.anthropic?.cacheControl);
	t.falsy(result.system![1].providerOptions);
});

test('applyCachePolicy - Anthropic: stamps latest user message', t => {
	const messages: ModelMessage[] = [
		{role: 'user', content: [{type: 'text', text: 'first'}]},
		{role: 'assistant', content: [{type: 'text', text: 'reply'}]},
		{role: 'user', content: [{type: 'text', text: 'second'}]},
	];
	const result = applyCachePolicy(undefined, messages, undefined, 'anthropic');
	t.not(result.messages, messages);
	const last = result.messages[2];
	t.truthy(last);
	const parts = last!.content as Array<{type: string; providerOptions?: unknown}>;
	t.truthy(parts[0].providerOptions);
});

test('applyCachePolicy - Anthropic: falls back to latest assistant when no user', t => {
	// No user message in this array — only assistant messages (e.g. a
	// replayed history starting with an assistant turn).
	const messages: ModelMessage[] = [
		{role: 'assistant', content: [{type: 'text', text: 'a'}]},
	];
	const result = applyCachePolicy(undefined, messages, undefined, 'anthropic');
	const stamped = result.messages[0];
	t.truthy(stamped);
	const parts = stamped!.content as Array<{providerOptions?: unknown}>;
	t.truthy(parts[0].providerOptions);
});

// ============================================================================
// applyCachePolicy — budget overflow
// ============================================================================

test('applyCachePolicy - all three positions fit within budget (3 ≤ 4)', t => {
	const blocks: SystemPromptBlock[] = [
		{text: 'stable', cacheScope: 'stable'},
	];
	const messages: ModelMessage[] = [
		{role: 'user', content: [{type: 'text', text: 'hi'}]},
	];
	const tools = {read_file: {} as AISDKCoreTool};
	const result = applyCachePolicy(blocks, messages, tools, 'anthropic');
	t.is(result.dropped, 0);
	t.truthy(result.tools!.read_file.providerOptions);
	t.truthy(result.system![0].providerOptions);
	t.truthy(
		(result.messages[0].content as Array<{providerOptions?: unknown}>)[0]
			.providerOptions,
	);
});

test('applyCachePolicy - empty inputs produce no markers and no crash', t => {
	const result = applyCachePolicy([], [], {}, 'anthropic');
	t.is(result.dropped, 0);
	t.deepEqual(result.tools, {});
});

// ============================================================================
// Back-compat wrappers
// ============================================================================

test('buildCachedSystemMessages - Anthropic stamps last stable block', t => {
	const blocks: SystemPromptBlock[] = [
		{text: 'a', cacheScope: 'stable'},
		{text: 'b', cacheScope: 'volatile'},
	];
	const result = buildCachedSystemMessages(blocks, 'anthropic');
	t.truthy(result);
	t.is(result!.length, 2);
	t.truthy(result![0].providerOptions);
	t.falsy(result![1].providerOptions);
});

test('buildCachedSystemMessages - returns undefined for non-Anthropic', t => {
	const result = buildCachedSystemMessages(
		[{text: 'a', cacheScope: 'stable'}],
		'openai-compatible',
	);
	t.is(result, undefined);
});

test('applyMessageCaching - stamps last user message for Anthropic', t => {
	const messages: ModelMessage[] = [
		{role: 'user', content: [{type: 'text', text: 'hi'}]},
	];
	const result = applyMessageCaching(messages, 'anthropic');
	t.not(result, messages);
	t.truthy(
		(result[0].content as Array<{providerOptions?: unknown}>)[0].providerOptions,
	);
});

test('applyMessageCaching - no-op for non-Anthropic', t => {
	const messages: ModelMessage[] = [
		{role: 'user', content: [{type: 'text', text: 'hi'}]},
	];
	t.is(applyMessageCaching(messages, 'google'), messages);
});

test('countBreakpoints - returns 0 for non-Anthropic', t => {
	t.is(countBreakpoints(undefined, [], 'openai-compatible'), 0);
});

test('countBreakpoints - counts system + message markers for Anthropic', t => {
	const blocks: SystemPromptBlock[] = [
		{text: 'stable', cacheScope: 'stable'},
	];
	const messages: ModelMessage[] = [
		{role: 'user', content: [{type: 'text', text: 'hi'}]},
	];
	const count = countBreakpoints(blocks, messages, 'anthropic');
	t.true(count >= 1 && count <= ANTHROPIC_BREAKPOINT_CAP);
});
