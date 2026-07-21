// Standalone raw-ANSI debug renderer for DiffView. NOT an AVA spec — this is
// a helper script spawned as a child process (with FORCE_COLOR forced in its
// env) by DiffView.ansi.spec.ts, matching the pattern used to verify the
// double-highlight nesting during the earlier diff-view work: Ink's own
// color output and cli-highlight's bundled chalk@4 both cache their
// "does this stream support color" decision at module-load time, so the only
// reliable way to force real SGR codes into `lastFrame()` output is a fresh
// process with FORCE_COLOR set before any of that machinery imports. AVA
// itself runs each spec file in its own process but doesn't set FORCE_COLOR,
// so the assertion has to happen out-of-process.
//
// Excluded from the AVA glob (`source/**/*.spec.ts(x)`) by its filename.
import {render} from 'ink-testing-library';
import React from 'react';
import type {DiffLine} from '@/components/diff-view/compute';
import DiffView from '@/components/diff-view/DiffView';
import {themes} from '@/config/themes';
import {ThemeContext} from '@/hooks/useTheme';

function MockThemeProvider({children}: {children: React.ReactNode}) {
	const mockTheme = {
		currentTheme: 'tokyo-night' as const,
		colors: themes['tokyo-night'].colors,
		setCurrentTheme: () => {},
	};
	return (
		<ThemeContext.Provider value={mockTheme}>{children}</ThemeContext.Provider>
	);
}

// A word-diff'd remove/add pair over a code line — exercises the deepest
// nesting case: outer line bg, inner word-diff bg, cli-highlight fg codes
// layered inside both.
const lines: DiffLine[] = [
	{
		kind: 'remove',
		oldLineNo: 1,
		text: 'const value = oldFn(a, b);',
		segments: [
			{type: 'unchanged', text: 'const value = '},
			{type: 'removed', text: 'oldFn(a, b)'},
			{type: 'unchanged', text: ';'},
		],
	},
	{
		kind: 'add',
		newLineNo: 1,
		text: 'const value = newFn(a, b);',
		segments: [
			{type: 'unchanged', text: 'const value = '},
			{type: 'added', text: 'newFn(a, b)'},
			{type: 'unchanged', text: ';'},
		],
	},
];

const {lastFrame} = render(
	<MockThemeProvider>
		<DiffView lines={lines} width={60} filePath="example.ts" />
	</MockThemeProvider>,
);

process.stdout.write(JSON.stringify({frame: lastFrame() ?? ''}));
