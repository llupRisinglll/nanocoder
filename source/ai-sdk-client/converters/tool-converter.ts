import {resolveToCanonical} from '@/tools/tool-aliases';
import type {ToolCall} from '@/types/index';
import {generateToolCallId} from '@/utils/tool-call-id';

/**
 * Converts AI SDK tool call format to our ToolCall format.
 *
 * The model may call a tool by any of its known aliases (e.g. `Bash` for
 * `execute_bash`, `apply_patch` for `diff_edit`). We resolve the incoming
 * `toolName` back to the canonical internal name here, so the rest of the
 * pipeline (handler dispatch, formatters, validators) always sees the name
 * it was registered under.
 */
export function convertAISDKToolCall(toolCall: {
	toolCallId?: string;
	toolName: string;
	input: unknown;
}): ToolCall {
	return {
		id: toolCall.toolCallId || generateToolCallId(),
		function: {
			name: resolveToCanonical(toolCall.toolName),
			arguments: toolCall.input as Record<string, unknown>,
		},
	};
}

/**
 * Converts multiple AI SDK tool calls to our ToolCall format. Each call's
 * tool name is resolved from any known alias to the canonical internal name.
 */
export function convertAISDKToolCalls(
	toolCalls: Array<{
		toolCallId?: string;
		toolName: string;
		input: unknown;
	}>,
): ToolCall[] {
	return toolCalls.map(convertAISDKToolCall);
}

/**
 * Gets the tool result output as a string
 */
export function getToolResultOutput(output: unknown): string {
	return typeof output === 'string' ? output : JSON.stringify(output);
}
