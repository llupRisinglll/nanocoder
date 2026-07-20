/**
 * Prompt-caching support for the AI SDK call site.
 *
 * Two provider families dominate the landscape and they cache differently:
 *
 *   - Anthropic-format (`sdkProvider === 'anthropic'`): caches via explicit
 *     `cache_control: {type: 'ephemeral'}` breakpoints placed on message
 *     parts, system blocks, and tool definitions. Hard cap of 4 breakpoints
 *     per request. Cache reads billed at ~0.1x base, writes at ~1.25x.
 *   - OpenAI-format (`chatgpt-codex`, `github-copilot`, and OpenAI-direct):
 *     implicit prefix caching keyed by `prompt_cache_key` + `store`. No inline
 *     markers — the provider caches whatever prefix it can match. Handled in
 *     `buildProviderOptions`, not here.
 *
 * This module owns the Anthropic-format policy: where to place breakpoints
 * (tools → system → latest user message, in invalidation order) and the
 * 4-breakpoint budget that backs it. OpenAI-format providers get a no-op here;
 * their caching is driven entirely by `promptCacheKey` at the call site.
 *
 * Reference: opencode `packages/llm/src/cache-policy.ts` and
 * `packages/llm/src/protocols/utils/cache.ts`. opencode's `applyCachePolicy`
 * marks the same three positions and uses the same budget allocator; we follow
 * that design because the invalidation-order reasoning is identical.
 */

import type {
	AssistantContent,
	JSONValue,
	ModelMessage,
	SystemModelMessage,
	UserContent,
} from 'ai';
import type {AISDKCoreTool} from '@/types/index';
import type {TaggedProvider} from './providers/provider-factory.js';

type ProviderOptions = NonNullable<SystemModelMessage['providerOptions']>;

/**
 * The cache scope assigned to a system-prompt block. `stable` blocks should be
 * cached (they don't change across a session); `volatile` blocks should NOT
 * carry a cache breakpoint because they change every turn (cwd, date, AGENTS.md
 * contents) and would invalidate the cache.
 */
export type CacheScope = 'stable' | 'volatile';

/**
 * A system-prompt block with its cache scope. `buildSystemPromptBlocks()`
 * produces these; the chat handler converts them to `SystemModelMessage[]`
 * with the appropriate `providerOptions` for the active provider.
 */
export interface SystemPromptBlock {
	text: string;
	cacheScope: CacheScope;
}

/**
 * Provider kinds that support inline (Anthropic-style) prompt-cache markers.
 * Deliberately Anthropic-only: the installed `@ai-sdk/openai-compatible`
 * provider does not read message-level `cache_control`, and OpenAI/Codex use
 * top-level `promptCacheKey` instead.
 */
export type CacheableProviderKind = Extract<
	TaggedProvider['kind'],
	'anthropic'
>;

/**
 * The Anthropic API enforces a hard limit of 4 cache breakpoints per request
 * (verified in @ai-sdk/anthropic@3 `CacheControlValidator`, and in opencode's
 * `ANTHROPIC_BREAKPOINT_CAP`). We allocate the budget in invalidation order:
 * tools → system → messages. When the budget overflows we shed message-tail
 * breakpoints first (tools and system are higher in the cache hierarchy and
 * more valuable to keep).
 */
export const ANTHROPIC_BREAKPOINT_CAP = 4;

/**
 * Returns true iff this provider kind supports inline prompt-cache markers.
 * Used by the chat handler to decide whether to run the cache-policy pass.
 */
export function providerSupportsCaching(
	kind: TaggedProvider['kind'],
): kind is CacheableProviderKind {
	return kind === 'anthropic';
}

/**
 * The `providerOptions` shape that marks an Anthropic cache breakpoint. The
 * AI SDK's anthropic provider reads this from system messages, content parts,
 * and tool definitions (see `@ai-sdk/anthropic` `getCacheControl`).
 */
function cacheBreakpointOptions(): ProviderOptions {
	return {anthropic: {cacheControl: {type: 'ephemeral'}}};
}

// =============================================================================
// Budget allocator — opencode `protocols/utils/cache.ts` parity
// =============================================================================

/**
 * Mutable counter for the Anthropic 4-breakpoint cap. Allocated once per
 * request and shared across tools/system/message stamping so the pass can
 * shed lower-priority breakpoints when the budget overflows.
 *
 * `dropped` counts how many breakpoints were requested but not placed, so the
 * chat handler can log a warning when a request would have over-marked.
 */
export interface Breakpoints {
	remaining: number;
	dropped: number;
}

export function newBreakpoints(cap: number): Breakpoints {
	return {remaining: cap, dropped: 0};
}

/**
 * Consume one breakpoint from the budget. Returns the marker to stamp, or
 * `undefined` if the budget is exhausted (in which case `dropped` is bumped).
 */
function consume(breakpoints: Breakpoints): ProviderOptions | undefined {
	if (breakpoints.remaining <= 0) {
		breakpoints.dropped++;
		return undefined;
	}
	breakpoints.remaining--;
	return cacheBreakpointOptions();
}

// =============================================================================
// Cache-policy pass — opencode `cache-policy.ts` parity
// =============================================================================

/**
 * The result of running the cache-policy pass over a request. All fields are
 * new arrays/objects — the caller's inputs are never mutated.
 */
export interface CachePolicyResult {
	system: SystemModelMessage[] | undefined;
	messages: ModelMessage[];
	tools: Record<string, AISDKCoreTool> | undefined;
	/** How many requested breakpoints were dropped due to budget overflow. */
	dropped: number;
}

/**
 * Stamp cache breakpoints across the request in invalidation order:
 *
 *   1. Last tool definition (tool schemas are large and stable across a
 *      session — highest cache leverage).
 *   2. Last stable system block (identity, principles, tool rules).
 *   3. Last content part of the latest user message (covers the conversation
 *      prefix so the next turn hits the cache).
 *
 * This mirrors opencode's `applyCachePolicy` "auto" shape. The budget is
 * shared so if (somehow) all three positions can't fit, message-tail markers
 * are shed first.
 *
 * No-op for providers that don't support inline markers — returns the inputs
 * unchanged with `dropped: 0`.
 */
export function applyCachePolicy(
	inputSystem: SystemPromptBlock[] | undefined,
	inputMessages: ModelMessage[],
	inputTools: Record<string, AISDKCoreTool> | undefined,
	kind: TaggedProvider['kind'],
): CachePolicyResult {
	if (!providerSupportsCaching(kind)) {
		return {
			system: undefined,
			messages: inputMessages,
			tools: inputTools,
			dropped: 0,
		};
	}

	const breakpoints = newBreakpoints(ANTHROPIC_BREAKPOINT_CAP);

	// 1) Tools — mark the last tool definition. Tool schemas (especially MCP
	//    tools with verbose descriptions) are often 5-15k tokens and stable
	//    for the whole session, so this is the single highest-leverage marker.
	const tools = markLastTool(inputTools, breakpoints);

	// 2) System — mark the last STABLE block. Volatile blocks (cwd, date,
	//    AGENTS.md) get no marker: they change per turn and would bust the
	//    cached stable prefix.
	const system = markSystem(inputSystem, breakpoints);

	// 3) Messages — mark the last content part of the latest user message.
	//    Falls back to the last assistant message if there's no user message
	//    (e.g. mid-tool-loop). Tool-result-only messages are skipped.
	const messages = markLatestMessage(inputMessages, breakpoints);

	return {system, messages, tools, dropped: breakpoints.dropped};
}

/**
 * Stamp a breakpoint on the last tool definition. Returns a new tools record
 * (shallow-cloned entries) or the original if there's nothing to mark or the
 * budget is exhausted.
 */
function markLastTool(
	tools: Record<string, AISDKCoreTool> | undefined,
	breakpoints: Breakpoints,
): Record<string, AISDKCoreTool> | undefined {
	if (!tools) return tools;
	const entries = Object.entries(tools);
	if (entries.length === 0) return tools;

	const cacheOpts = consume(breakpoints);
	if (!cacheOpts) return tools;

	const lastIdx = entries.length - 1;
	const result: Record<string, AISDKCoreTool> = {};
	entries.forEach(([name, toolDef], i) => {
		result[name] =
			i === lastIdx
				? ({
						...toolDef,
						providerOptions: {
							...(toolDef.providerOptions ?? {}),
							...cacheOpts,
						},
					} as AISDKCoreTool)
				: toolDef;
	});
	return result;
}

/**
 * Convert the structured system-prompt blocks into `SystemModelMessage[]`,
 * stamping a breakpoint on the last STABLE block. Volatile blocks are emitted
 * without a marker. Returns `undefined` if there are no blocks.
 */
function markSystem(
	blocks: SystemPromptBlock[] | undefined,
	breakpoints: Breakpoints,
): SystemModelMessage[] | undefined {
	if (!blocks || blocks.length === 0) return undefined;

	// Find the index of the last stable block.
	let lastStableIdx = -1;
	for (let i = blocks.length - 1; i >= 0; i--) {
		if (blocks[i].cacheScope === 'stable' && blocks[i].text.length > 0) {
			lastStableIdx = i;
			break;
		}
	}

	// No stable content → nothing to cache; emit blocks as-is with no markers.
	if (lastStableIdx === -1) {
		return blocks
			.filter(b => b.text.length > 0)
			.map(b => ({role: 'system', content: b.text}));
	}

	const cacheOpts = consume(breakpoints);
	const result: SystemModelMessage[] = [];
	for (let i = 0; i <= lastStableIdx; i++) {
		const block = blocks[i];
		if (block.text.length === 0) continue;
		result.push({
			role: 'system',
			content: block.text,
			...(i === lastStableIdx && cacheOpts ? {providerOptions: cacheOpts} : {}),
		});
	}
	// Append the volatile blocks (system-info, AGENTS.md) with no marker.
	for (let i = lastStableIdx + 1; i < blocks.length; i++) {
		const block = blocks[i];
		if (block.text.length === 0) continue;
		result.push({role: 'system', content: block.text});
	}
	return result;
}

/**
 * Stamp a breakpoint on the last content part of the latest user message
 * (falling back to the latest assistant message if no user message exists).
 * Tool-result-only and system messages are skipped.
 *
 * Clones shallowly — never mutates the caller's message objects.
 */
function markLatestMessage(
	messages: ModelMessage[],
	breakpoints: Breakpoints,
): ModelMessage[] {
	if (messages.length === 0) return messages;

	const cacheOpts = consume(breakpoints);
	if (!cacheOpts) return messages;

	// Try latest user message first; fall back to latest assistant.
	const targetIdx =
		findLastIndexOfRole(messages, 'user') >= 0
			? findLastIndexOfRole(messages, 'user')
			: findLastIndexOfRole(messages, 'assistant');

	if (targetIdx < 0) return messages;
	const msg = messages[targetIdx];
	if (msg.role === 'system' || msg.role === 'tool') return messages;

	const content = msg.content as UserContent | AssistantContent;
	if (!Array.isArray(content) || content.length === 0) return messages;

	// Clone the message + content array shallowly, then clone the last
	// stampable part. Work on unknown[] because the AI SDK content-part union
	// is strict: every part has a valid runtime `providerOptions` slot, but
	// TypeScript cannot prove that for a generic cloned part.
	const newContent = content.slice() as unknown[];
	let stamped = false;
	for (let j = newContent.length - 1; j >= 0; j--) {
		const part = newContent[j] as {
			type: string;
			providerOptions?: ProviderOptions;
			[key: string]: JSONValue | ProviderOptions | undefined;
		};
		// Don't stamp tool-approval parts — providers reject cache markers
		// on them (the AI SDK warns and ignores them anyway).
		if (
			part.type === 'tool-approval-request' ||
			part.type === 'tool-approval-response'
		) {
			continue;
		}
		newContent[j] = {
			...part,
			providerOptions: {
				...(part.providerOptions ?? {}),
				...cacheOpts,
			},
		};
		stamped = true;
		break;
	}
	if (!stamped) return messages;

	const newMsg = {...msg, content: newContent} as ModelMessage;
	const result = messages.slice();
	result[targetIdx] = newMsg;
	return result;
}

function findLastIndexOfRole(
	messages: ModelMessage[],
	role: ModelMessage['role'],
): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === role) return i;
	}
	return -1;
}

// =============================================================================
// Back-compat wrappers (deprecated — prefer applyCachePolicy)
// =============================================================================

/**
 * @deprecated Use `applyCachePolicy` instead. Kept so external callers and
 * tests that only care about the system-message shape keep working.
 */
export function buildCachedSystemMessages(
	blocks: SystemPromptBlock[],
	kind: TaggedProvider['kind'],
): SystemModelMessage[] | undefined {
	if (!providerSupportsCaching(kind)) return undefined;
	return markSystem(blocks, newBreakpoints(ANTHROPIC_BREAKPOINT_CAP));
}

/**
 * @deprecated Use `applyCachePolicy` instead. Kept for back-compat.
 */
export function applyMessageCaching(
	messages: ModelMessage[],
	kind: TaggedProvider['kind'],
): ModelMessage[] {
	if (!providerSupportsCaching(kind)) return messages;
	return markLatestMessage(messages, newBreakpoints(ANTHROPIC_BREAKPOINT_CAP));
}

/**
 * @deprecated Use `applyCachePolicy(...).dropped` instead.
 */
export function countBreakpoints(
	systemBlocks: SystemPromptBlock[] | undefined,
	messages: ModelMessage[],
	kind: TaggedProvider['kind'],
): number {
	if (!providerSupportsCaching(kind)) return 0;
	const result = applyCachePolicy(systemBlocks, messages, undefined, kind);
	let count = 0;
	if (result.system?.some(m => m.providerOptions)) count++;
	if (result.messages !== messages) count++;
	return Math.min(count, ANTHROPIC_BREAKPOINT_CAP);
}
