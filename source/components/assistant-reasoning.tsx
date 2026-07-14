import {Box, Text} from 'ink';
import {useMemo, useRef} from 'react';
import {formatElapsed} from '@/components/animated-gear-timer';
import {useNonInteractiveRender} from '@/hooks/useNonInteractiveRender';
import {useTerminalWidth} from '@/hooks/useTerminalWidth';
import {useTheme} from '@/hooks/useTheme';
import {Colors, parseMarkdown} from '@/markdown-parser/index';
import type {AssistantReasoningProps} from '@/types/index';
import {wrapWithTrimmedContinuations} from '@/utils/text-wrapping';
import {calculateTokens} from '@/utils/token-calculator';

// Module-level store for reasoning start times, shared across components.
// StreamingReasoning sets it when reasoning starts; AssistantReasoning reads it.
let lastReasoningStartTime: number | null = null;

export function setReasoningStartTime(time: number) {
	lastReasoningStartTime = time;
}

// Indent applied to the expanded body so the "⚙ Thought" header acts as a
// section header with its body (and any tool summary that follows) grouped
// beneath it. Keep in sync with the marginLeft used in
// displayCompactCountsSummary.
const EXPANDED_INDENT = 2;

export default function AssistantReasoning({
	reasoning,
	expand,
	startTime,
}: AssistantReasoningProps) {
	// Capture start time on first render only — don't update if module-level
	// variable changes (next reasoning overwrites it).
	const capturedStartTime = useRef(startTime ?? lastReasoningStartTime);
	const effectiveStartTime = capturedStartTime.current;
	const mountTimeRef = useRef(Date.now());
	const thinkingDurationMs = effectiveStartTime
		? mountTimeRef.current - effectiveStartTime
		: null;
	const thinkingDuration =
		thinkingDurationMs !== null ? Math.floor(thinkingDurationMs / 1000) : null;
	const isFastThinking = thinkingDuration !== null && thinkingDuration < 1;
	const {colors} = useTheme();
	const boxWidth = useTerminalWidth();
	const nonInteractive = useNonInteractiveRender();
	const tokens = calculateTokens(reasoning);
	const effectiveWidth = Math.max(1, boxWidth - EXPANDED_INDENT);

	// Render markdown to terminal-formatted text
	// Pre-wrap to avoid Ink's trim:false leaving leading spaces on wrapped lines
	const renderedMessage = useMemo(() => {
		try {
			// Reasoning should be rendered subtly, so render markdown with single color
			const mutedColors: Colors = {
				text: colors.secondary,
				primary: colors.secondary,
				secondary: colors.secondary,
				success: colors.secondary,
				error: colors.secondary,
				warning: colors.secondary,
				info: colors.secondary,
				tool: colors.secondary,
			};
			const parsed = parseMarkdown(
				reasoning,
				mutedColors,
				effectiveWidth,
			).trimEnd();
			return wrapWithTrimmedContinuations(parsed, effectiveWidth);
		} catch {
			// Fallback to plain text if markdown parsing fails
			return wrapWithTrimmedContinuations(reasoning.trimEnd(), effectiveWidth);
		}
	}, [reasoning, colors, effectiveWidth]);

	return (
		<Box flexDirection="column" marginBottom={1}>
			<Box>
				<Text color={colors.tool}>{'⚙'} Thought</Text>
				{thinkingDuration !== null && (
					<Text color={colors.secondary}>
						{isFastThinking
							? ' (<1s)'
							: ` (${formatElapsed(thinkingDuration)})`}
					</Text>
				)}
				{!expand && !nonInteractive && (
					<Text color={colors.secondary}>{'  '}ctrl+r to expand</Text>
				)}
			</Box>
			{expand && (
				<Box flexDirection="column" marginLeft={EXPANDED_INDENT}>
					<Box marginBottom={1}>
						<Text color={colors.secondary} italic>
							{renderedMessage}
						</Text>
					</Box>
					<Box>
						<Text color={colors.secondary}>
							~{tokens.toLocaleString()} tokens{' '}
						</Text>
					</Box>
				</Box>
			)}
		</Box>
	);
}
