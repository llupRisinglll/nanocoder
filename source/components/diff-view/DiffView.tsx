import {Box, Text} from 'ink';
import React from 'react';
import {themes} from '@/config/themes';
import {useTheme} from '@/hooks/useTheme';
import type {Colors} from '@/types/ui';
import type {DiffSegment} from '@/utils/inline-diff';
import type {DiffLine, DiffLineKind} from './compute.js';
import {highlightCode, languageForPath} from './syntax.js';

export interface DiffViewProps {
	/** Flat, already-computed line list (see `computeDiffLines`). */
	lines: DiffLine[];
	/** Total terminal width available for the diff block. Default 80. */
	width?: number;
	/** Cap the number of logical diff lines rendered; unlimited when omitted. */
	maxLines?: number;
	/**
	 * Source file path used to detect a `cli-highlight` language and layer
	 * syntax token colors under the diff backgrounds. Omit to render plain
	 * (no highlighting) — the default for callers that don't have a path.
	 */
	filePath?: string;
}

const DEFAULT_WIDTH = 80;

type WrapPart = {type: DiffSegment['type']; text: string};

/** Line-level background/foreground/word-highlight colors per diff kind. */
function lineColors(
	kind: DiffLineKind,
	colors: Colors,
): {bg: string | undefined; text: string; wordBg: string | undefined} {
	if (kind === 'remove') {
		return {
			bg: colors.diffRemoved,
			text: colors.diffRemovedText,
			wordBg: colors.diffRemovedWord,
		};
	}
	if (kind === 'add') {
		return {
			bg: colors.diffAdded,
			text: colors.diffAddedText,
			wordBg: colors.diffAddedWord,
		};
	}
	return {bg: undefined, text: colors.text, wordBg: undefined};
}

function sigilFor(kind: DiffLineKind): string {
	if (kind === 'remove') return '-';
	if (kind === 'add') return '+';
	return ' ';
}

function segmentsForLine(line: DiffLine): WrapPart[] {
	if (line.segments && line.segments.length > 0) {
		return line.segments.map(segment => ({
			type: segment.type,
			text: segment.text,
		}));
	}
	return [{type: 'unchanged', text: line.text}];
}

/**
 * Word-wrap a sequence of typed parts (word-diff segments) into rows whose
 * total text length does not exceed `width`, splitting on whitespace so
 * highlighted words stay intact where possible. A single token longer than
 * `width` is hard-split at the width boundary. Mirrors openclaude's manual
 * wrap loop but keeps each token's segment type attached so the caller can
 * still render word-level highlight after wrapping.
 */
function wrapParts(parts: WrapPart[], width: number): WrapPart[][] {
	const safeWidth = Math.max(width, 1);

	const tokens: WrapPart[] = [];
	for (const part of parts) {
		const pieces = part.text.split(/(\s+)/).filter(piece => piece.length > 0);
		for (const piece of pieces) tokens.push({type: part.type, text: piece});
	}

	const rows: WrapPart[][] = [];
	let row: WrapPart[] = [];
	let rowLength = 0;

	const pushRow = () => {
		rows.push(row);
		row = [];
		rowLength = 0;
	};

	for (const token of tokens) {
		let text = token.text;

		while (text.length > safeWidth) {
			if (rowLength > 0) pushRow();
			row.push({type: token.type, text: text.slice(0, safeWidth)});
			pushRow();
			text = text.slice(safeWidth);
		}

		if (text.length === 0) continue;

		if (rowLength + text.length > safeWidth && rowLength > 0) pushRow();
		row.push({type: token.type, text});
		rowLength += text.length;
	}

	if (row.length > 0 || rows.length === 0) rows.push(row);

	// Continuation rows that start with a wrap-artifact space (broke right
	// after a whitespace token) drop that leading space, same treatment as
	// `wrapWithTrimmedContinuations`.
	return rows.map((r, i) => {
		if (i === 0 || r.length === 0) return r;
		const first = r[0];
		if (first && /^\s+$/.test(first.text)) return r.slice(1);
		return r;
	});
}

/**
 * Shared renderer for computed diff line lists (`computeDiffLines` output).
 * Dual old/new line-number gutter, full-width solid-bar line backgrounds,
 * word-level double-highlight nesting, and long-line wrapping with a
 * continuation-row empty gutter. Pure/presentational — no call sites wired.
 */
export default function DiffView({
	lines,
	width = DEFAULT_WIDTH,
	maxLines,
	filePath,
}: DiffViewProps): React.ReactElement {
	const {colors, currentTheme} = useTheme();

	// Contrast guard: cli-highlight's default theme assumes a dark terminal
	// background. Only layer syntax token colors on dark themes — light
	// themes keep the plain diffAddedText/diffRemovedText colors (v1; a
	// custom cli-highlight theme derived from the active palette is future
	// work).
	const themeType = themes[currentTheme]?.themeType ?? 'dark';
	const detectedLanguage = filePath ? languageForPath(filePath) : '';
	const highlightEnabled = detectedLanguage.length > 0 && themeType === 'dark';
	const language = detectedLanguage;

	const visibleLines =
		maxLines !== undefined && maxLines < lines.length
			? lines.slice(0, maxLines)
			: lines;
	const hiddenCount =
		maxLines !== undefined && maxLines < lines.length
			? lines.length - maxLines
			: 0;

	let oldWidth = 1;
	let newWidth = 1;
	for (const line of lines) {
		if (line.oldLineNo !== undefined) {
			oldWidth = Math.max(oldWidth, String(line.oldLineNo).length);
		}
		if (line.newLineNo !== undefined) {
			newWidth = Math.max(newWidth, String(line.newLineNo).length);
		}
	}

	// `{old} {new} {sigil} ` — two number columns, each followed by a space,
	// the sigil, and a trailing space before content.
	const gutterWidth = oldWidth + newWidth + 4;
	const contentWidth = Math.max(width - gutterWidth, 1);

	const rowElements: React.ReactElement[] = [];

	visibleLines.forEach((line, lineIndex) => {
		const {bg, text: lineText, wordBg} = lineColors(line.kind, colors);
		const sigil = sigilFor(line.kind);
		const oldStr =
			line.oldLineNo !== undefined
				? String(line.oldLineNo).padStart(oldWidth)
				: ' '.repeat(oldWidth);
		const newStr =
			line.newLineNo !== undefined
				? String(line.newLineNo).padStart(newWidth)
				: ' '.repeat(newWidth);
		const gutterText = `${oldStr} ${newStr} ${sigil} `;

		const parts = segmentsForLine(line);
		const rows = wrapParts(parts, contentWidth);

		rows.forEach((row, rowIndex) => {
			const rowLength = row.reduce((sum, part) => sum + part.text.length, 0);
			const padding = ' '.repeat(Math.max(contentWidth - rowLength, 0));
			const prefix = rowIndex === 0 ? gutterText : ' '.repeat(gutterWidth);

			rowElements.push(
				<Box key={`${lineIndex}-${rowIndex}`} flexDirection="row">
					<Text backgroundColor={bg} color={lineText}>
						{prefix}
					</Text>
					<Text backgroundColor={bg} color={lineText} wrap="truncate-end">
						{row.map((part, partIndex) => {
							const display = highlightEnabled
								? highlightCode(part.text, language)
								: part.text;
							return part.type === 'unchanged' ? (
								display
							) : (
								<Text
									key={`${lineIndex}-${rowIndex}-${partIndex}`}
									backgroundColor={wordBg}
								>
									{display}
								</Text>
							);
						})}
						{padding}
					</Text>
				</Box>,
			);
		});
	});

	return (
		<Box flexDirection="column">
			{rowElements}
			{hiddenCount > 0 && (
				<Text color={colors.secondary}>
					...{hiddenCount} more line{hiddenCount !== 1 ? 's' : ''}
				</Text>
			)}
		</Box>
	);
}
