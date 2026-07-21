import {execFileSync} from 'node:child_process';
import test from 'ava';
import {highlightCode, languageForPath} from './syntax.js';

// ============================================================================
// languageForPath
// ============================================================================

test('languageForPath detects a known extension', t => {
	t.is(languageForPath('source/foo.ts'), 'typescript');
	t.is(languageForPath('source/foo.py'), 'python');
});

test('languageForPath falls back gracefully for unknown/missing extensions', t => {
	// Neither call should throw; the exact fallback id is
	// `getLanguageFromExtension`'s concern, not this wrapper's.
	t.notThrows(() => languageForPath('Makefile'));
	t.notThrows(() => languageForPath('source/foo.unknownext'));
});

// ============================================================================
// highlightCode
// ============================================================================

test('highlightCode returns the original text unchanged for empty input', t => {
	t.is(highlightCode('', 'typescript'), '');
});

test('highlightCode wraps known-language text in ANSI escape codes', t => {
	// cli-highlight's bundled chalk@4 decides "does this stream support
	// color" once, at module-load time — setting FORCE_COLOR from inside
	// this file would be too late (ESM imports are hoisted, so `syntax.js`
	// has already imported `cli-highlight` before any top-level statement
	// here runs). Spawn a fresh process with FORCE_COLOR set up front
	// instead, same approach as `DiffView.ansi.spec.ts`.
	const script = `
		process.env.FORCE_COLOR = '3';
		const {highlightCode} = await import('./syntax.js');
		process.stdout.write(highlightCode('const x = 1;', 'typescript'));
	`;
	const result = execFileSync(
		process.execPath,
		['--import=tsx', '--no-warnings', '--input-type=module', '-e', script],
		{cwd: import.meta.dirname, env: {...process.env}, encoding: 'utf-8'},
	);
	// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting ANSI presence
	t.regex(result, /\x1b\[/);
});

test('highlightCode never throws and falls back to plain text on bad input', t => {
	// A bogus language id makes cli-highlight throw internally; the wrapper
	// must swallow that and return the original text untouched.
	const text = 'some code fragment';
	t.notThrows(() => highlightCode(text, 'not-a-real-language'));
	const result = highlightCode(text, 'not-a-real-language');
	t.is(result, text);
});
