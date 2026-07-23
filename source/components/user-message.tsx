import {Box, Text} from 'ink';
import {memo} from 'react';
import {getTextboxBackground} from '@/config/themes';
import {useNonInteractiveRender} from '@/hooks/useNonInteractiveRender';
import {useResponsiveTerminal} from '@/hooks/useTerminalWidth';
import {useTheme} from '@/hooks/useTheme';
import type {UserMessageProps} from '@/types/index';
import {wrapWithTrimmedContinuations} from '@/utils/text-wrapping';
import {calculateTokens} from '@/utils/token-calculator';

const ICON_PROMPT_HISTORY_BACKGROUND = '#2a2a2a';

// Strip VS Code context blocks from display (code is still sent to LLM)
function stripVSCodeContext(message: string): string {
	return message.replace(
		/<!--vscode-context-->[\s\S]*?<!--\/vscode-context-->/g,
		'',
	);
}

function collapseCustomCommandPrompt(message: string): string {
	const match = message.match(
		/^\[Executing custom command: (\/.+?)\]\s*(?:\n|$)/,
	);
	if (!match) return message;
	return match[1];
}

// Display-only cap for very long messages (e.g. expanded large pastes): show
// head and tail with a hidden-lines marker. The full text still goes to the LLM.
const MAX_DISPLAY_CHARS = 10_000;
const DISPLAY_HEAD_CHARS = 8_000;
const DISPLAY_TAIL_CHARS = 1_500;

function capForDisplay(text: string): string {
	if (text.length <= MAX_DISPLAY_CHARS) {
		return text;
	}

	const head = text.slice(0, DISPLAY_HEAD_CHARS);
	const tail = text.slice(-DISPLAY_TAIL_CHARS);
	const hiddenLines = text
		.slice(DISPLAY_HEAD_CHARS, -DISPLAY_TAIL_CHARS)
		.split('\n').length;
	return `${head}\n… +${hiddenLines} lines …\n${tail}`;
}

// Parse a line and return segments with file/image placeholders highlighted
function parseLineWithPlaceholders(line: string) {
	const segments: Array<{text: string; isPlaceholder: boolean}> = [];
	const filePattern = /\[@[^\]]+\]|\[Image #\d+\]/g;
	let lastIndex = 0;
	let match;

	while ((match = filePattern.exec(line)) !== null) {
		// Add text before the placeholder
		if (match.index > lastIndex) {
			segments.push({
				text: line.slice(lastIndex, match.index),
				isPlaceholder: false,
			});
		}

		// Add the placeholder
		segments.push({
			text: match[0],
			isPlaceholder: true,
		});

		lastIndex = match.index + match[0].length;
	}

	// Add remaining text
	if (lastIndex < line.length) {
		segments.push({
			text: line.slice(lastIndex),
			isPlaceholder: false,
		});
	}

	return segments;
}

export default memo(function UserMessage({
	message,
	tokenContent,
	imageCount = 0,
}: UserMessageProps) {
	const {colors} = useTheme();
	const {boxWidth, actualWidth} = useResponsiveTerminal();
	const nonInteractive = useNonInteractiveRender();
	const tokens = calculateTokens(tokenContent ?? message);

	// Non-interactive (`run`) mode: the user already knows what prompt they
	// submitted — echoing it back as a boxed "You:" block is pure noise.
	if (nonInteractive) {
		return null;
	}

	// Arrow style (theme promptChar): "❯ message" in a surface-filled box with
	// no border or label, instead of the "You:" block
	const arrowMode = Boolean(colors.promptChar);

	// boxWidth floors at 40 (useTerminalWidth), which EXCEEDS the real width of
	// terminals narrower than ~44 columns. A fixed-width row wider than the
	// terminal hard-wraps in the terminal itself; Ink's erase accounting counts
	// logical newlines only, so every subsequent repaint under-erases and
	// composites over the residue rows — the garbled/overlapping echo seen when
	// a wrapped multi-line message commits from the live region into Static.
	// Cap the arrow box at the true terminal width (minus the root padding
	// column and a right-edge safety column). At columns >= 44 this equals
	// boxWidth exactly, so normal-width rendering is unchanged; the classic
	// (non-arrow) path is untouched for theme parity.
	const arrowBoxWidth = Math.max(20, Math.min(boxWidth, actualWidth - 2));
	const effectiveBoxWidth = arrowMode ? arrowBoxWidth : boxWidth;

	// Inner text width. Arrow mode: outer width minus side margins (2), rounded
	// border (2), paddingX (2), and the "❯ " prefix (2). Classic: left border
	// (1) + padding (1 each side).
	const textWidth = effectiveBoxWidth - (arrowMode ? 8 : 3);

	// Strip VS Code context blocks and pre-wrap to avoid Ink's trim:false
	// leaving leading spaces on wrapped lines
	const displayMessage = wrapWithTrimmedContinuations(
		capForDisplay(collapseCustomCommandPrompt(stripVSCodeContext(message))),
		textWidth,
	);
	const lines = displayMessage.split('\n');

	const renderedLines = (
		<Box flexDirection="column">
			{lines.map((line, lineIndex) => {
				// Skip empty lines - they create paragraph spacing via marginBottom
				if (line.trim() === '') {
					return null;
				}

				const segments = parseLineWithPlaceholders(line);
				const isEndOfParagraph =
					lineIndex + 1 < lines.length && lines[lineIndex + 1].trim() === '';

				return (
					<Box key={lineIndex} marginBottom={isEndOfParagraph ? 1 : 0}>
						<Text>
							{segments.map((segment, segIndex) => (
								<Text
									key={segIndex}
									color={segment.isPlaceholder ? colors.info : colors.text}
									bold={segment.isPlaceholder}
								>
									{segment.text}
								</Text>
							))}
						</Text>
					</Box>
				);
			})}
		</Box>
	);

	return (
		<>
			{arrowMode ? (
				<Box
					marginTop={1}
					marginBottom={0}
					width={effectiveBoxWidth}
					backgroundColor={ICON_PROMPT_HISTORY_BACKGROUND}
				>
					<Text color={colors.primary} bold>
						{colors.promptChar}{' '}
					</Text>
					{renderedLines}
				</Box>
			) : (
				<>
					<Box marginBottom={1}>
						<Text color={colors.primary} bold>
							You:
						</Text>
					</Box>
					<Box
						flexDirection="column"
						marginBottom={1}
						backgroundColor={getTextboxBackground(colors)}
						width={boxWidth}
						padding={1}
						borderStyle="bold"
						borderLeft={true}
						borderRight={false}
						borderTop={false}
						borderBottom={false}
						borderLeftColor={colors.primary}
					>
						{renderedLines}
					</Box>
				</>
			)}
			{imageCount > 0 && (
				<Box marginBottom={1}>
					<Text color={colors.info}>
						■ {imageCount} image{imageCount === 1 ? '' : 's'} attached
					</Text>
				</Box>
			)}
			<Box paddingLeft={arrowMode ? 2 : 0} marginBottom={arrowMode ? 1 : 2}>
				<Text color={colors.secondary}>~{tokens.toLocaleString()} tokens</Text>
			</Box>
		</>
	);
});
