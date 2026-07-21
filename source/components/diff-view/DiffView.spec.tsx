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
// Single shared gutter alignment (remove/add rows, no dual context numbers)
// ============================================================================

test('DiffView right-aligns remove/add line numbers to one shared gutter column', t => {
	// A pure rewrite (no context lines): 1 removed line (old #1, single
	// digit) vs 2 added lines, one with a single-digit number (new #1) and
	// one with a two-digit number (new #10) — forcing oldWidth !== newWidth.
	// The removed line's number and the "new #1" line's number both have one
	// digit, so — once numbers share a single right-aligned gutter column —
	// they must start at the *same* column index. Before the fix, the
	// removed number lived in its own flush-left old-number slot (index 0)
	// while added numbers lived right-aligned in the new-number slot, so
	// this would fail.
	const lines: DiffLine[] = [
		{kind: 'remove', oldLineNo: 1, text: 'removed line'},
		{kind: 'add', newLineNo: 1, text: 'added line one'},
		{kind: 'add', newLineNo: 10, text: 'added line ten'},
	];

	const {lastFrame} = render(
		<MockThemeProvider>
			<DiffView lines={lines} width={40} />
		</MockThemeProvider>,
	);

	const output = lastFrame() ?? '';
	const rows = output.split('\n').filter(line => line.trim().length > 0);
	t.is(rows.length, 3);

	const [removeRow, addRow1, addRow10] = rows;
	const digitStart = (row: string) => row.search(/\d/);

	// Sigils land in one shared column across all rows.
	const sigilColumns = rows.map(row => row.indexOf(row.includes('-') ? '-' : '+'));
	t.true(sigilColumns.every(col => col === sigilColumns[0]));

	// Same digit count (1 and 1) => same gutter start column.
	t.is(
		digitStart(removeRow!),
		digitStart(addRow1!),
		`removed-line number and single-digit added-line number must share one right-aligned gutter column; rows: ${JSON.stringify(
			[removeRow, addRow1],
		)}`,
	);

	// The two-digit added number starts one column earlier than its
	// single-digit sibling, since both end at the same right-aligned edge.
	t.is(digitStart(addRow10!), digitStart(addRow1!) - 1);
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

// ============================================================================
// Syntax highlighting (Phase 3)
// ============================================================================

test('DiffView preserves visible text when a filePath enables syntax highlighting', t => {
	const lines: DiffLine[] = [
		{kind: 'context', oldLineNo: 1, newLineNo: 1, text: 'const a = 1;'},
		{kind: 'remove', oldLineNo: 2, text: 'const old = fn();'},
		{kind: 'add', newLineNo: 2, text: 'const next = fn();'},
	];

	const {lastFrame} = render(
		<MockThemeProvider>
			<DiffView lines={lines} width={40} filePath="example.ts" />
		</MockThemeProvider>,
	);

	// stripAnsi isn't imported here — assert on substrings that survive
	// regardless of any embedded ANSI codes cli-highlight may have inserted
	// between tokens (word boundaries stay intact; only single tokens like
	// `const` could get wrapped, so match short, single-token substrings).
	const output = lastFrame() ?? '';
	t.regex(output, /a = 1;/);
	t.regex(output, /old = fn\(\);/);
	t.regex(output, /next = fn\(\);/);
});

test('DiffView skips highlighting (plain diff colors only) on a light theme', t => {
	const lines: DiffLine[] = [
		{kind: 'remove', oldLineNo: 1, text: 'const old = 1;'},
		{kind: 'add', newLineNo: 1, text: 'const next = 1;'},
	];

	const withHighlightAttempt = render(
		<MockThemeProvider theme="catppuccin-latte">
			<DiffView lines={lines} width={40} filePath="example.ts" />
		</MockThemeProvider>,
	);
	const withoutFilePath = render(
		<MockThemeProvider theme="catppuccin-latte">
			<DiffView lines={lines} width={40} />
		</MockThemeProvider>,
	);

	// Light theme + filePath must render identically to no filePath at all —
	// the contrast guard disables highlighting outright rather than risking
	// unreadable token colors on a light background.
	t.is(withHighlightAttempt.lastFrame(), withoutFilePath.lastFrame());
});

test('DiffView renders plain text when no filePath is given (no language detected)', t => {
	const lines: DiffLine[] = [
		{kind: 'add', newLineNo: 1, text: 'const value = 1;'},
	];

	const {lastFrame} = render(
		<MockThemeProvider>
			<DiffView lines={lines} width={40} />
		</MockThemeProvider>,
	);

	const output = lastFrame() ?? '';
	t.regex(output, /const value = 1;/);
});
