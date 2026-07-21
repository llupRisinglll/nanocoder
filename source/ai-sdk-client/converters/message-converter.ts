import type {
	AssistantContent,
	FilePart,
	ImagePart,
	ModelMessage,
	TextPart,
	ToolCallPart,
	UserContent,
} from 'ai';
import type {ImageAttachment, Message} from '@/types/index';
import type {TestableMessage} from '../types.js';

/**
 * Drop images whose base64 payload exceeds this size (per image). Providers
 * reject oversized images with a 400 (e.g. Anthropic's 5MB image / 100MB total
 * request limits, OpenAI's per-request cap). We preemptively drop the largest
 * offenders so one bad paste doesn't fail the whole turn. The text part of the
 * user message still goes through; we just lose the image.
 *
 * Set conservatively at 4MB base64 (~3MB raw) to stay under both Anthropic and
 * OpenAI limits. Codex/opencode normalize images down before sending (see
 * opencode `Image.Service`); a follow-up could integrate sharp/resizing.
 */
const MAX_IMAGE_BASE64_BYTES = 4 * 1024 * 1024;

function isImageMediaType(mediaType: string): boolean {
	return mediaType.toLowerCase().startsWith('image/');
}

/**
 * Convert an `ImageAttachment` to an AI SDK image part with provider-aware
 * detail metadata. Returns `null` if the image should be dropped (too large).
 */
function toImagePart(image: ImageAttachment): ImagePart | null {
	if (image.data.length > MAX_IMAGE_BASE64_BYTES) return null;
	// `imageDetail: 'auto'` lets OpenAI/Codex pick high/low based on size;
	// matches Codex's default after it strips explicit `detail` (see
	// codex-rs/core/src/client_common.rs:64 `strip_image_details`). The
	// providerOptions are ignored by providers that don't read them.
	return {
		type: 'image',
		image: `data:${image.mediaType};base64,${image.data}`,
		mediaType: image.mediaType,
		providerOptions: {openai: {imageDetail: 'auto'}},
	};
}

/**
 * Convert a non-image attachment (PDF, text, etc.) to an AI SDK file part.
 * Claude accepts PDFs as file parts; OpenAI accepts them in the Responses API.
 * Image-y media types are handled by `toImagePart` instead.
 */
function toFilePart(attachment: ImageAttachment): FilePart {
	return {
		type: 'file',
		data: attachment.data,
		mediaType: attachment.mediaType,
		...(attachment.source
			? {filename: attachment.source.split('/').pop() || undefined}
			: {}),
	};
}

/**
 * Checks if an assistant message is empty (no content and no tool calls).
 * Empty assistant messages cause API errors:
 * "400 Bad Request: Assistant message must have either content or tool_calls, but not none."
 *
 * Exported for testing purposes.
 */
export function isEmptyAssistantMessage(message: TestableMessage): boolean {
	if (message.role !== 'assistant') {
		return false;
	}
	// Check for content - handle both string and array content formats
	const hasContent = Array.isArray(message.content)
		? message.content.length > 0
		: typeof message.content === 'string' && message.content.trim().length > 0;
	// Tool calls are in a separate property for AI SDK messages
	const hasToolCalls =
		'toolCalls' in message &&
		Array.isArray(message.toolCalls) &&
		message.toolCalls.length > 0;
	return !hasContent && !hasToolCalls;
}

/**
 * Drop tool-result messages whose tool_call_id matches no tool_call in a
 * preceding assistant message. Orphaned tool results arise when history
 * compaction summarises an assistant(tool_calls) turn but keeps its tool
 * results verbatim; OpenAI-compatible providers reject the dangling result
 * (or return an empty completion). This is a defensive net for any path that
 * can orphan a result — the primary fix lives in the compaction slicer.
 *
 * Exported for testing.
 */
export function dropOrphanedToolResults(messages: Message[]): Message[] {
	const seenToolCallIds = new Set<string>();
	const result: Message[] = [];
	for (const msg of messages) {
		if (msg.role === 'tool') {
			if (msg.tool_call_id && seenToolCallIds.has(msg.tool_call_id)) {
				result.push(msg);
			}
			// else: orphaned tool result with no matching prior tool_call — drop.
			continue;
		}
		if (msg.role === 'assistant' && msg.tool_calls) {
			for (const toolCall of msg.tool_calls) {
				if (toolCall.id) seenToolCallIds.add(toolCall.id);
			}
		}
		result.push(msg);
	}
	return result;
}

/**
 * Convert our Message format to AI SDK v6 ModelMessage format
 *
 * Tool messages: Converted to AI SDK tool-result format with proper structure.
 * Orphaned tool results are dropped first (see dropOrphanedToolResults).
 */
export function convertToModelMessages(messages: Message[]): ModelMessage[] {
	return dropOrphanedToolResults(messages).map((msg): ModelMessage => {
		if (msg.role === 'tool') {
			// Convert to AI SDK tool-result format
			// AI SDK expects: { role: 'tool', content: [{ type: 'tool-result', toolCallId, toolName, output }] }
			// where output is { type: 'text', value: string } or { type: 'json', value: JSONValue }.
			// Structured tool results travel as JSON so the model can reason over
			// the typed shape; everything else falls back to the text content.
			const output =
				msg.structuredContent !== undefined
					? ({type: 'json', value: msg.structuredContent} as const)
					: ({type: 'text', value: msg.content} as const);
			return {
				role: 'tool',
				content: [
					{
						type: 'tool-result',
						toolCallId: msg.tool_call_id || '',
						toolName: msg.name || '',
						output,
					},
				],
			};
		}

		if (msg.role === 'system') {
			return {
				role: 'system',
				content: msg.content,
			};
		}

		if (msg.role === 'user') {
			// Multimodal turn: emit the text alongside one part per attachment.
			// Images travel as data URLs (accepted by Anthropic, Google, and
			// OpenAI-compatible providers); non-image attachments (PDFs, etc.)
			// travel as FilePart (Claude accepts these in-tool-result too).
			// Oversized images are dropped rather than failing the whole request.
			if (msg.images && msg.images.length > 0) {
				const content: UserContent = [];
				if (msg.content) {
					content.push({type: 'text', text: msg.content} as TextPart);
				}
				let droppedImages = 0;
				for (const attachment of msg.images) {
					if (isImageMediaType(attachment.mediaType)) {
						const part = toImagePart(attachment);
						if (part) {
							content.push(part);
						} else {
							droppedImages++;
						}
					} else {
						content.push(toFilePart(attachment));
					}
				}
				if (droppedImages > 0) {
					content.push({
						type: 'text',
						text: `[${droppedImages} image${droppedImages === 1 ? '' : 's'} omitted: exceeded the per-image size limit. Re-attach smaller images if needed.]`,
					} as TextPart);
				}
				return {
					role: 'user',
					content,
				};
			}

			return {
				role: 'user',
				content: msg.content,
			};
		}

		if (msg.role === 'assistant') {
			// Build content array
			const content: AssistantContent = [];

			// Add text content if present
			if (msg.content) {
				content.push({
					type: 'text',
					text: msg.content,
				} as TextPart);
			}

			// Add tool calls if present (for auto-executed messages)
			if (msg.tool_calls && msg.tool_calls.length > 0) {
				for (const toolCall of msg.tool_calls) {
					content.push({
						type: 'tool-call',
						toolCallId: toolCall.id,
						toolName: toolCall.function.name,
						input: toolCall.function.arguments,
					} as ToolCallPart);
				}
			}

			// If no content at all, add empty text to avoid empty message
			if (content.length === 0) {
				content.push({
					type: 'text',
					text: '',
				} as TextPart);
			}

			return {
				role: 'assistant',
				content,
			};
		}

		// Fallback - should never happen
		return {
			role: 'user',
			content: msg.content,
		};
	});
}
