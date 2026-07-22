import {Box, Text} from 'ink';
import {useMemo} from 'react';
import {useTerminalWidth} from '@/hooks/useTerminalWidth';
import {useTheme} from '@/hooks/useTheme';
import {type Colors, parseMarkdown} from '@/markdown-parser/index';
import type {SteeringUrgency} from '@/steering/types';
import {wrapWithTrimmedContinuations} from '@/utils/text-wrapping';

export interface InnerDaemonDetailsProps {
	/** The steering nudge text (1-3 sentences). */
	message: string;
	/** Visual weight: `light` (default grey) or `firm` (warning-accented glyph). */
	urgency?: SteeringUrgency;
	/**
	 * Optional rule id shown after the glyph, for traceability
	 * (which steering rule fired). Omit for a cleaner look.
	 */
	ruleId?: string;
}

/**
 * InnerDaemon steering nudge, rendered as a subtle "light detail".
 *
 * Mirrors {@link AssistantReasoning}'s muted treatment: the body is markdown-
 * rendered in a single `colors.secondary` color so it reads as quiet guidance,
 * not a loud error. A `◆ InnerDaemon` header identifies the source. Loud
 * `ErrorMessage` boxes are reserved for hard `stop` actions (rendered by the
 * conversation loop, not here).
 *
 * Always expanded — unlike reasoning, a steering nudge is short by design
 * (1-3 sentences) and must be immediately legible; collapsing it would hide
 * the very guidance the layer exists to surface.
 *
 * Theme-safety: uses only the existing `colors.secondary` and `colors.warning`
 * fields. No new theme fields are introduced (per the theme-system rule), so
 * the ~50 bundled themes render this identically to reasoning.
 */
export default function InnerDaemonDetails({
	message,
	urgency = 'light',
	ruleId,
}: InnerDaemonDetailsProps) {
	const {colors} = useTheme();
	const boxWidth = useTerminalWidth();
	const effectiveWidth = Math.max(1, boxWidth - 2);

	const renderedMessage = useMemo(() => {
		try {
			// Single-color muted markdown, exactly like AssistantReasoning.
			const muted: Colors = {
				text: colors.secondary,
				primary: colors.secondary,
				secondary: colors.secondary,
				success: colors.secondary,
				error: colors.secondary,
				warning: colors.secondary,
				info: colors.secondary,
				tool: colors.secondary,
			};
			const parsed = parseMarkdown(message, muted, effectiveWidth).trimEnd();
			return wrapWithTrimmedContinuations(parsed, effectiveWidth);
		} catch {
			return wrapWithTrimmedContinuations(message.trimEnd(), effectiveWidth);
		}
	}, [message, colors, effectiveWidth]);

	// `firm` urgency accents the glyph in warning color while keeping the body
	// muted; `light` (the default) keeps everything secondary-grey.
	const glyphColor = urgency === 'firm' ? colors.warning : colors.secondary;

	return (
		<Box flexDirection="column" marginBottom={1}>
			<Box paddingLeft={2}>
				<Text color={glyphColor}>{'◆'} InnerDaemon</Text>
				{ruleId && <Text color={colors.secondary}> · {ruleId}</Text>}
				{urgency === 'firm' && <Text color={colors.warning}> (steering)</Text>}
			</Box>
			<Box flexDirection="column" marginLeft={2}>
				<Text color={colors.secondary} italic>
					{renderedMessage}
				</Text>
			</Box>
		</Box>
	);
}
