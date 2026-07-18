import test from 'ava';
import {render} from 'ink-testing-library';
import React from 'react';
import {themes} from '../../config/themes.js';
import {ThemeContext} from '../../hooks/useTheme.js';
import {computeDiffLines, type DiffLine} from './compute.js';
import DiffView from './DiffView.js';

// Mock ThemeProvider for testing — same pattern as user-message.spec.tsx.
function MockThemeProvider({
	children,
	theme = 'tokyo-night' as const,
}: {
	children: React.ReactNode;
	theme?: keyof typeof themes;
}) {
	const mockTheme = {
		currentTheme: theme,
		colors: themes[theme].colors,
		setCurrentTheme: () => {},
	};

	return (
		<ThemeContext.Provider value={mockTheme}>{children}</ThemeContext.Provider>
	);
}

// ============================================================================
// Gutter numbers
// ============================================================================

test('DiffView shows correct dual gutter numbers for a mixed hunk', t => {
	const oldText = 'a\nb\nc\nd\n';
	const newText = 'a\nb\nNEW\nc\nd\n';
	const lines = computeDiffLines(oldText, newText);

	const {lastFrame} = render(
		<MockThemeProvider>
			<DiffView lines={lines} width={40} />
		</MockThemeProvider>,
	);

	const output = lastFrame() ?? '';

	// Context line "b" is old line 2 / new line 2 — both numbers shown.
	t.regex(output, /2\s+2\s+b/);
	// Pure addition "NEW" only has a new-side line number (3); no old number.
	t.regex(output, /3\s+\+\s+NEW/);
	// Context line "c" shifts: old 3 / new 4.
	t.regex(output, /3\s+4\s+c/);
});

// ============================================================================
// Sigils
// ============================================================================

test('DiffView renders +/- sigils for added and removed lines', t => {
	const lines: DiffLine[] = [
		{kind: 'context', oldLineNo: 1, newLineNo: 1, text: 'unchanged'},
		{kind: 'remove', oldLineNo: 2, text: 'old line'},
		{kind: 'add', newLineNo: 2, text: 'new line'},
	];

	const {lastFrame} = render(
		<MockThemeProvider>
			<DiffView lines={lines} width={40} />
		</MockThemeProvider>,
	);

	const output = lastFrame() ?? '';
	t.regex(output, /-\s+old line/);
	t.regex(output, /\+\s+new line/);
});

// ============================================================================
// maxLines footer
// ============================================================================

test('DiffView shows "...N more lines" footer when maxLines truncates', t => {
	const lines: DiffLine[] = Array.from({length: 10}, (_, i) => ({
		kind: 'context' as const,
		oldLineNo: i + 1,
		newLineNo: i + 1,
		text: `line ${i + 1}`,
	}));

	const {lastFrame} = render(
		<MockThemeProvider>
			<DiffView lines={lines} width={40} maxLines={4} />
		</MockThemeProvider>,
	);

	const output = lastFrame() ?? '';
	t.regex(output, /\.\.\.6 more lines/);
	t.regex(output, /line 1\b/);
	t.false(output.includes('line 5'));
});

test('DiffView renders no footer when maxLines is omitted', t => {
	const lines: DiffLine[] = Array.from({length: 5}, (_, i) => ({
		kind: 'context' as const,
		oldLineNo: i + 1,
		newLineNo: i + 1,
		text: `line ${i + 1}`,
	}));

	const {lastFrame} = render(
		<MockThemeProvider>
			<DiffView lines={lines} width={40} />
		</MockThemeProvider>,
	);

	const output = lastFrame() ?? '';
	t.false(output.includes('more line'));
	t.regex(output, /line 5/);
});

// ============================================================================
// Wrapping
// ============================================================================

test('DiffView wraps long lines into continuation rows with empty gutter', t => {
	const longText = Array.from({length: 20}, (_, i) => `word${i}`).join(' ');
	const lines: DiffLine[] = [
		{kind: 'add', newLineNo: 1, text: longText},
	];

	const {lastFrame} = render(
		<MockThemeProvider>
			<DiffView lines={lines} width={24} />
		</MockThemeProvider>,
	);

	const output = lastFrame() ?? '';
	const rows = output.split('\n').filter(line => line.trim().length > 0);

	// The single logical line must have wrapped into more than one row.
	t.true(rows.length > 1);
	// First row carries the gutter/sigil.
	t.regex(rows[0]!, /\+/);
	// Continuation row(s) still hold wrapped content but no sigil/number —
	// only the wrapped words prefixed by blank gutter spacing.
	t.false(rows[1]!.includes('+'));
	t.regex(rows[1]!, /word\d/);
});

// ============================================================================
// Theme-agnostic (dual theme) rendering
// ============================================================================

test('DiffView renders consistent structure across themes (tokyo-night + catppuccin-latte)', t => {
	// NOTE: the requested "omnicode" theme does not exist in
	// source/config/themes.json (verified against the full ThemePreset union
	// in source/types/ui.ts); tokyo-night (dark) and catppuccin-latte (light)
	// are used instead to prove the renderer is theme-agnostic across a
	// dark/light pair.
	const lines: DiffLine[] = [
		{kind: 'context', oldLineNo: 1, newLineNo: 1, text: 'same line'},
		{kind: 'remove', oldLineNo: 2, text: 'old value here'},
		{kind: 'add', newLineNo: 2, text: 'new value here'},
	];

	for (const theme of ['tokyo-night', 'catppuccin-latte'] as const) {
		const {lastFrame} = render(
			<MockThemeProvider theme={theme}>
				<DiffView lines={lines} width={40} />
			</MockThemeProvider>,
		);

		const output = lastFrame() ?? '';
		t.truthy(output);
		t.regex(output, /same line/);
		t.regex(output, /old value here/);
		t.regex(output, /new value here/);
		t.regex(output, /-\s+old value here/);
		t.regex(output, /\+\s+new value here/);
	}
});
