import {Box, Text} from 'ink';
import Spinner from 'ink-spinner';
import {memo, useRef} from 'react';
import {AnimatedGear, ElapsedTimer} from '@/components/animated-gear-timer';
import {setReasoningStartTime} from '@/components/assistant-reasoning';
import {useNonInteractiveRender} from '@/hooks/useNonInteractiveRender';
import {useTerminalWidth} from '@/hooks/useTerminalWidth';
import {useTheme} from '@/hooks/useTheme';
import {wrapWithTrimmedContinuations} from '@/utils/text-wrapping';
import {calculateTokens} from '@/utils/token-calculator';

/**
 * Lightweight streaming reasoning component. Shows the last N lines of
 * plain text to avoid expensive markdown parsing and terminal reflow
 * on every token update. The final AssistantReasoning handles full rendering.
 */
export default memo(function StreamingReasoning({
	reasoning,
	expand,
	startTime,
}: {
	reasoning: string;
	expand: boolean;
	startTime?: number;
}) {
	// Snapshot the wall clock on first render so tok/s measures streaming
	// throughput rather than request-send-to-now (which over-counts the
	// pre-first-token latency for reasoning models).
	const startRef = useRef<number>(startTime ?? Date.now());
	const effectiveStartTime = startRef.current;

	// Store start time for AssistantReasoning to read later
	setReasoningStartTime(effectiveStartTime);
	const {colors} = useTheme();
	const boxWidth = useTerminalWidth();
	const nonInteractive = useNonInteractiveRender();
	const textWidth = boxWidth - 3;

	// Only show the tail of the content to keep the render small
	// and avoid off-screen reflow that causes iTerm2 flickering.
	const MAX_LINES = 12;
	const wrapped = wrapWithTrimmedContinuations(reasoning.trimEnd(), textWidth);
	const lines = wrapped.split('\n');
	const truncated = lines.length > MAX_LINES;
	const visibleLines = truncated ? lines.slice(-MAX_LINES) : lines;
	const displayText = visibleLines.join('\n');

	const tokens = calculateTokens(reasoning);
	const elapsedSec = (Date.now() - effectiveStartTime) / 1000;
	const tokPerSec = elapsedSec > 0.1 ? (tokens / elapsedSec).toFixed(1) : '—';

	return (
		<Box flexDirection="column" marginBottom={2}>
			<Box>
				<Text color={colors.tool}>
					<AnimatedGear /> Thinking
					<Spinner type="simpleDots" />
				</Text>
				<ElapsedTimer startTime={effectiveStartTime} />
				{expand ? (
					<Text>
						{'  '}~{tokens.toLocaleString()} tokens · {tokPerSec} tok/s
					</Text>
				) : nonInteractive ? null : (
					<Text color={colors.secondary}>{'  '}ctrl+r to expand</Text>
				)}
			</Box>
			{expand && (
				<Box flexDirection="column">
					{truncated && <Text color={colors.secondary}>…</Text>}
					<Text color={colors.secondary} italic>
						{displayText}
					</Text>
				</Box>
			)}
		</Box>
	);
});
