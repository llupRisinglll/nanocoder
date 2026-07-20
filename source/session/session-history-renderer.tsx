import {Box, Text} from 'ink';
import React, {memo} from 'react';
import AssistantMessage from '@/components/assistant-message';
import {InfoMessage} from '@/components/message-box';
import UserMessage from '@/components/user-message';
import {useTerminalWidth} from '@/hooks/useTerminalWidth';
import {useTheme} from '@/hooks/useTheme';
import {generateKey} from '@/session/key-generator';
import type {Message, ToolCall} from '@/types/core';
import {parseToolArguments} from '@/utils/tool-args-parser';

/**
 * Cap on how many trailing messages are replayed into scrollback on resume.
 * The point of the replay is recognition ("did I resume the right session?"),
 * not a full re-render of a possibly huge history. Older messages are still
 * loaded into model context — only their UI replay is omitted, with a note.
 */
const MAX_REPLAYED_MESSAGES = 60;
const MAX_DESCRIPTOR_LENGTH = 80;

function truncate(value: string, max = MAX_DESCRIPTOR_LENGTH): string {
	const single = value.replace(/\s+/g, ' ').trim();
	return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

function describeToolCall(toolCall: ToolCall): string {
	const name = toolCall.function.name;
	const args = parseToolArguments<Record<string, unknown>>(
		toolCall.function.arguments,
	);
	const str = (key: string): string =>
		typeof args[key] === 'string' ? (args[key] as string) : '';

	switch (name) {
		case 'read_file':
		case 'write_file':
		case 'string_replace':
		case 'diff_edit':
		case 'list_directory':
			return str('path') || str('file_path');
		case 'execute_bash':
			return str('command');
		case 'search_file_contents':
			return str('pattern') || str('query');
		case 'find_files':
			return str('pattern') || str('name') || str('query');
		case 'web_search':
			return str('query');
		case 'fetch_url':
			return str('url');
		case 'agent': {
			const type = str('subagent_type');
			const desc = str('description');
			return [type, desc].filter(Boolean).join(': ');
		}
		default: {
			const keys = Object.keys(args);
			if (keys.length === 0) return '';
			const first = args[keys[0]];
			return typeof first === 'string' ? first : keys.join(', ');
		}
	}
}

/** True when a tool result string represents an error the user should notice. */
function isErrorResult(content: string | undefined): boolean {
	if (!content) return false;
	return (
		content.startsWith('Error: ') || content.startsWith('⚒ Validation failed')
	);
}

interface PendingToolGroup {
	count: number;
	descriptors: string[];
	failed: boolean;
}

interface LatestToolHint {
	toolName: string;
	descriptor: string;
}

function moreLabel(toolName: string, count: number): string {
	const noun =
		toolName === 'execute_bash'
			? 'command'
			: toolName === 'read_file'
				? 'file'
				: 'call';
	return `${count} more ${noun}${count === 1 ? '' : 's'}`;
}

const HistoryToolSummary = memo(function HistoryToolSummary({
	groups,
	latestHint,
}: {
	groups: Array<[string, PendingToolGroup]>;
	latestHint?: LatestToolHint;
}) {
	const {colors} = useTheme();
	const boxWidth = useTerminalWidth();
	const hintGroup = latestHint
		? groups.find(([name]) => name === latestHint.toolName)?.[1]
		: undefined;
	const remaining = hintGroup ? Math.max(0, hintGroup.count - 1) : 0;
	const moreText = latestHint
		? `… +${moreLabel(latestHint.toolName, remaining)} (ctrl + o to verbose)`
		: '';

	return (
		<Box width={boxWidth} flexDirection="column">
			<Text>
				<Text color={colors.tool}>⚒ </Text>
				{groups.map(([toolName, group], index) => (
					<React.Fragment key={toolName}>
						<Text color={colors.primary}>{toolName}</Text>
						{group.count > 1 && (
							<Text color={colors.text}> ×{group.count}</Text>
						)}
						{group.failed && <Text color={colors.error}> failed</Text>}
						{index + 1 < groups.length && (
							<Text color={colors.secondary}>, </Text>
						)}
					</React.Fragment>
				))}
			</Text>
			{latestHint?.descriptor && (
				<Text color={colors.secondary}>
					└ {truncate(latestHint.descriptor)}
				</Text>
			)}
			{latestHint && remaining > 0 && (
				<Text color={colors.secondary}> {moreText}</Text>
			)}
		</Box>
	);
});

const HistoryThoughtSummary = memo(function HistoryThoughtSummary() {
	const {colors} = useTheme();
	const boxWidth = useTerminalWidth();
	return (
		<Box width={boxWidth}>
			<Text color={colors.secondary}>
				⚙ Thought <Text color={colors.secondary}>(ctrl+r to expand)</Text>
			</Text>
		</Box>
	);
});

/**
 * Convert a persisted session's message history into a list of components that
 * replay the conversation in scrollback when a session is resumed.
 *
 * Replay is deliberately faithful-but-light: user prompts and assistant text
 * render in full (so the session is recognizable), reasoning renders collapsed,
 * and tool calls render as compact one-liners paired with their result status.
 * Tool formatters are intentionally NOT invoked (they can have side effects and
 * dump large output). Only the trailing `MAX_REPLAYED_MESSAGES` are replayed;
 * the rest are summarized with a leading note.
 *
 * @param messages - The full persisted message array.
 * @param model - The model label to show on assistant messages.
 */
export function buildSessionHistoryComponents(
	messages: Message[],
	model: string,
): React.ReactNode[] {
	const components: React.ReactNode[] = [];

	// Map every tool result by its tool_call_id across the FULL history, so an
	// in-window assistant tool call can still find its result even if windowing
	// trims nearby messages.
	const resultsById = new Map<string, string>();
	for (const message of messages) {
		if (message.role === 'tool' && message.tool_call_id) {
			resultsById.set(message.tool_call_id, message.content);
		}
	}

	// Replay only the trailing window; note how many earlier messages are hidden.
	const hiddenCount = Math.max(0, messages.length - MAX_REPLAYED_MESSAGES);
	const replayed = hiddenCount > 0 ? messages.slice(hiddenCount) : messages;
	let pendingThought = false;
	let pendingToolGroups: Record<string, PendingToolGroup> = {};
	let latestToolHint: LatestToolHint | undefined;

	const flushPendingActivity = () => {
		const toolEntries = Object.entries(pendingToolGroups);
		if (!pendingThought && toolEntries.length === 0) {
			return;
		}

		if (toolEntries.length > 0) {
			components.push(
				<HistoryToolSummary
					key={generateKey('resume-tool-activity')}
					groups={toolEntries}
					latestHint={latestToolHint}
				/>,
			);
		}
		if (pendingThought) {
			components.push(
				<HistoryThoughtSummary key={generateKey('resume-reasoning')} />,
			);
		}
		pendingThought = false;
		pendingToolGroups = {};
		latestToolHint = undefined;
	};

	if (hiddenCount > 0) {
		components.push(
			<InfoMessage
				key={generateKey('resume-history-truncated')}
				message={`${hiddenCount} earlier message${
					hiddenCount === 1 ? '' : 's'
				} hidden (still in context). Showing the most recent ${
					replayed.length
				}.`}
				hideBox={true}
			/>,
		);
	}

	for (const message of replayed) {
		switch (message.role) {
			case 'user':
				flushPendingActivity();
				if (message.content.trim()) {
					components.push(
						<UserMessage
							key={generateKey('resume-user')}
							message={message.content}
						/>,
					);
				}
				break;

			case 'assistant': {
				if (message.content.trim()) {
					flushPendingActivity();
					components.push(
						<AssistantMessage
							key={generateKey('resume-assistant')}
							message={message.content}
							model={model}
						/>,
					);
				}
				if (message.reasoning?.trim()) {
					pendingThought = true;
				}
				if (message.tool_calls && message.tool_calls.length > 0) {
					for (const toolCall of message.tool_calls) {
						const toolName = toolCall.function.name;
						const group =
							pendingToolGroups[toolName] ??
							(pendingToolGroups[toolName] = {
								count: 0,
								descriptors: [],
								failed: false,
							});
						group.count += 1;
						const descriptor = describeToolCall(toolCall);
						if (descriptor) {
							group.descriptors.push(descriptor);
							latestToolHint = {toolName, descriptor};
						}
						if (isErrorResult(resultsById.get(toolCall.id))) {
							group.failed = true;
						}
					}
				}
				break;
			}

			// Tool results are folded into their assistant tool-call summary above;
			// system messages are never displayed.
			default:
				break;
		}
	}
	flushPendingActivity();

	return components;
}
