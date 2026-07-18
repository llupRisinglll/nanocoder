import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import test from 'ava';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================================
// Raw-ANSI proof: syntax highlighting layered under the diff/word-diff
// backgrounds, per the Phase 3 plan's risk note.
//
// Ink's own color output and cli-highlight's bundled chalk@4 both decide
// "does this stream support color" once, at module-load time — so forcing
// real SGR codes into `lastFrame()` requires a *fresh process* with
// FORCE_COLOR set before any of that machinery imports (setting
// `process.env.FORCE_COLOR` from inside this spec file is too late: ESM
// imports are hoisted and Ink/chalk have already made their decision by the
// time any top-level statement runs). `diff-view-ansi-debug.tsx` is spawned
// here as that fresh process; it renders a word-diff'd, syntax-highlighted
// remove/add pair and prints the raw `lastFrame()` string as JSON.
// ============================================================================

function renderDebugFrame(): string {
	const scriptPath = join(
		__dirname,
		'../../test-utils/diff-view-ansi-debug.tsx',
	);
	const stdout = execFileSync(
		process.execPath,
		['--import=tsx', '--no-warnings', scriptPath],
		{
			env: {...process.env, FORCE_COLOR: '3'},
			encoding: 'utf-8',
		},
	);
	const parsed = JSON.parse(stdout) as {frame: string};
	return parsed.frame;
}

test('DiffView layers syntax fg codes inside both the line bg and word-diff bg (raw ANSI)', t => {
	const frame = renderDebugFrame();
	t.truthy(frame);

	// Line-level backgrounds: tokyo-night diffRemoved (#3a1f28 -> 58;31;40)
	// and diffAdded (#1f3a28 -> 31;58;40), truecolor SGR.
	t.true(
		frame.includes('\x1b[48;2;58;31;40m'),
		'missing removed-line bg SGR',
	);
	t.true(frame.includes('\x1b[48;2;31;58;40m'), 'missing added-line bg SGR');

	// Word-diff backgrounds: diffRemovedWord (#883344 -> 136;51;68) and
	// diffAddedWord (#338844 -> 51;136;68) — these must appear *nested*
	// inside the line-bg-colored output, proving the double-highlight trick
	// still holds once cli-highlight fg codes are layered into the mix.
	t.true(
		frame.includes('\x1b[48;2;136;51;68m'),
		'missing removed-word bg SGR',
	);
	t.true(frame.includes('\x1b[48;2;51;136;68m'), 'missing added-word bg SGR');

	// cli-highlight fg codes (e.g. the `const` keyword) are present, proving
	// syntax highlighting actually ran rather than silently falling back to
	// plain text.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: raw ANSI proof
	t.regex(frame, /\x1b\[34mconst/);

	// After a word-bg segment closes, output returns to the *outer line bg*
	// color (not a bare reset) — the mechanic the plan calls out: chalk's
	// close-code replacement keeps the outer bg alive across inner codes.
	t.true(
		frame.includes('\x1b[48;2;136;51;68moldFn(a, b)\x1b[48;2;58;31;40m'),
		'word bg on removed line did not fall back to the outer line bg on close',
	);
	t.true(
		frame.includes('\x1b[48;2;51;136;68mnewFn(a, b)\x1b[48;2;31;58;40m'),
		'word bg on added line did not fall back to the outer line bg on close',
	);
});
