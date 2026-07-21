import test from 'ava';
import {computeDiffLines} from './compute.js';

// ============================================================================
// Pure insertion mid-block
// ============================================================================

test('pure insertion mid-block: new line appears without shifting later context', t => {
	const oldText = 'a\nb\nc\nd\n';
	const newText = 'a\nb\nNEW\nc\nd\n';

	const result = computeDiffLines(oldText, newText);

	const added = result.filter(l => l.kind === 'add');
	t.is(added.length, 1);
	t.is(added[0]!.text, 'NEW');
	t.is(added[0]!.newLineNo, 3);

	// Every other line is untouched context, correctly numbered on both sides.
	const context = result.filter(l => l.kind === 'context');
	t.true(context.every(l => l.text !== 'NEW'));
	const cLine = context.find(l => l.text === 'c');
	t.truthy(cLine);
	t.is(cLine!.oldLineNo, 3);
	t.is(cLine!.newLineNo, 4);
	const dLine = context.find(l => l.text === 'd');
	t.is(dLine!.oldLineNo, 4);
	t.is(dLine!.newLineNo, 5);
});

// ============================================================================
// Pure deletion
// ============================================================================

test('pure deletion: removed line has no newLineNo and later lines renumber', t => {
	const oldText = 'a\nb\nc\nd\n';
	const newText = 'a\nc\nd\n';

	const result = computeDiffLines(oldText, newText);

	const removed = result.filter(l => l.kind === 'remove');
	t.is(removed.length, 1);
	t.is(removed[0]!.text, 'b');
	t.is(removed[0]!.oldLineNo, 2);
	t.is(removed[0]!.newLineNo, undefined);

	const cLine = result.find(l => l.text === 'c');
	t.is(cLine!.oldLineNo, 3);
	t.is(cLine!.newLineNo, 2);
});

// ============================================================================
// Scattered deletions (non-adjacent removals within one hunk)
// ============================================================================

test('scattered deletions: non-adjacent removals align correctly, not lock-step', t => {
	const oldText = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\n';
	const newText = 'l1\nl3\nl4\nl6\nl7\n';

	const result = computeDiffLines(oldText, newText);

	const removed = result.filter(l => l.kind === 'remove').map(l => l.text);
	t.deepEqual(removed, ['l2', 'l5']);

	// l3/l4/l6/l7 must remain plain context lines, not be misread as
	// replacements for l2/l5 by a lock-step walker.
	const context = result.filter(l => l.kind === 'context').map(l => l.text);
	t.deepEqual(context, ['l1', 'l3', 'l4', 'l6', 'l7']);

	const l6 = result.find(l => l.text === 'l6');
	t.is(l6!.oldLineNo, 6);
	t.is(l6!.newLineNo, 4);
});

// ============================================================================
// Similar-line pairing (adjacent remove+add run gets word-diff segments)
// ============================================================================

test('similar-line pairing: adjacent remove+add run produces word-diff segments', t => {
	const oldText = 'const x = 1;\n';
	const newText = 'const x = 2;\n';

	const result = computeDiffLines(oldText, newText);

	t.is(result.length, 2);
	const [removeLine, addLine] = result;
	t.is(removeLine!.kind, 'remove');
	t.is(addLine!.kind, 'add');
	t.truthy(removeLine!.segments);
	t.truthy(addLine!.segments);

	const removedSeg = removeLine!.segments!.find(s => s.type === 'removed');
	const addedSeg = addLine!.segments!.find(s => s.type === 'added');
	t.is(removedSeg!.text, '1');
	t.is(addedSeg!.text, '2');

	// Old line must not carry the "added" half, and vice versa.
	t.true(removeLine!.segments!.every(s => s.type !== 'added'));
	t.true(addLine!.segments!.every(s => s.type !== 'removed'));
});

// ============================================================================
// Change-ratio fallback (rewrite -> plain lines, no word-diff confetti)
// ============================================================================

test('change-ratio fallback: a near-total rewrite renders as plain lines', t => {
	const oldText = 'const x = 1;\n';
	const newText = 'export async function totallyDifferent() {}\n';

	const result = computeDiffLines(oldText, newText);

	t.is(result.length, 2);
	const [removeLine, addLine] = result;
	t.is(removeLine!.kind, 'remove');
	t.is(addLine!.kind, 'add');
	t.is(removeLine!.segments, undefined);
	t.is(addLine!.segments, undefined);
	t.is(removeLine!.text, 'const x = 1;');
	t.is(addLine!.text, 'export async function totallyDifferent() {}');
});

test('change-ratio fallback respects a custom threshold', t => {
	const oldText = 'hello world foo bar\n';
	const newText = 'hello there foo bar\n';

	// Only one word out of four changed; default threshold (0.6) keeps word-diff.
	const withDefault = computeDiffLines(oldText, newText);
	t.truthy(withDefault[0]!.segments);

	// A strict threshold pushes the same pair into the plain-line fallback.
	const withStrictThreshold = computeDiffLines(oldText, newText, {
		changeRatioThreshold: 0.1,
	});
	t.is(withStrictThreshold[0]!.segments, undefined);
});

// ============================================================================
// Multi-hunk output
// ============================================================================

test('multi-hunk output: two far-apart edits produce two independently numbered hunks', t => {
	const oldLines = Array.from({length: 20}, (_, i) => `l${i + 1}`);
	const newLines = [...oldLines];
	newLines[1] = 'CHANGED2';
	newLines[17] = 'CHANGED18';

	const oldText = oldLines.join('\n') + '\n';
	const newText = newLines.join('\n') + '\n';

	const result = computeDiffLines(oldText, newText);

	const added = result.filter(l => l.kind === 'add').map(l => l.text);
	t.deepEqual(added, ['CHANGED2', 'CHANGED18']);

	const removed = result.filter(l => l.kind === 'remove').map(l => l.text);
	t.deepEqual(removed, ['l2', 'l18']);

	const changed18 = result.find(l => l.text === 'CHANGED18');
	t.is(changed18!.newLineNo, 18);

	// Context around each hunk is present but the two hunks don't merge
	// into one contiguous run — l8..l14 (far from both edits) are absent.
	const contextTexts = result.filter(l => l.kind === 'context').map(l => l.text);
	t.false(contextTexts.includes('l10'));
});

// ============================================================================
// CRLF / trailing-newline edges
// ============================================================================

test('CRLF line endings: carriage returns are stripped from emitted text', t => {
	const oldText = 'a\r\nb\r\nc\r\n';
	const newText = 'a\r\nB\r\nc\r\n';

	const result = computeDiffLines(oldText, newText);

	for (const line of result) {
		t.false(line.text.includes('\r'));
	}
	const removed = result.find(l => l.kind === 'remove');
	const added = result.find(l => l.kind === 'add');
	t.is(removed!.text, 'b');
	t.is(added!.text, 'B');
});

test('trailing-newline edge: missing trailing newline does not emit a marker line', t => {
	const oldText = 'a\nb';
	const newText = 'a\nb\nc';

	const result = computeDiffLines(oldText, newText);

	t.true(result.every(l => !l.text.startsWith('\\ No newline')));

	// The old file's final line lacked a trailing newline, the new file's
	// doesn't — `diff` reports that as a change to the 'b' line itself
	// (paired remove+add) followed by a genuine new 'c' line.
	const addedTexts = result.filter(l => l.kind === 'add').map(l => l.text);
	t.deepEqual(addedTexts, ['b', 'c']);
	const cLine = result.find(l => l.kind === 'add' && l.text === 'c');
	t.is(cLine!.newLineNo, 3);
});

test('trailing-newline edge: identical text but one side lacks trailing newline', t => {
	const oldText = 'a\nb\n';
	const newText = 'a\nb';

	const result = computeDiffLines(oldText, newText);

	// `diff` treats this as a genuine (if subtle) change to the last line;
	// we should not crash and should not leak the "No newline" marker text.
	t.true(result.every(l => !l.text.startsWith('\\ No newline')));
});

// ============================================================================
// Empty-old (all additions) / empty-new (all removals)
// ============================================================================

test('empty old text: entire new text renders as additions', t => {
	const oldText = '';
	const newText = 'a\nb\nc\n';

	const result = computeDiffLines(oldText, newText);

	t.true(result.every(l => l.kind === 'add'));
	t.deepEqual(
		result.map(l => l.text),
		['a', 'b', 'c'],
	);
	t.deepEqual(
		result.map(l => l.newLineNo),
		[1, 2, 3],
	);
	t.true(result.every(l => l.oldLineNo === undefined));
});

test('empty new text: entire old text renders as removals', t => {
	const oldText = 'a\nb\nc\n';
	const newText = '';

	const result = computeDiffLines(oldText, newText);

	t.true(result.every(l => l.kind === 'remove'));
	t.deepEqual(
		result.map(l => l.text),
		['a', 'b', 'c'],
	);
	t.deepEqual(
		result.map(l => l.oldLineNo),
		[1, 2, 3],
	);
	t.true(result.every(l => l.newLineNo === undefined));
});

test('identical texts: no diff lines are emitted', t => {
	const text = 'a\nb\nc\n';
	const result = computeDiffLines(text, text);
	t.deepEqual(result, []);
});

test('context option is forwarded to structuredPatch', t => {
	const oldLines = Array.from({length: 20}, (_, i) => `l${i + 1}`);
	const newLines = [...oldLines];
	newLines[9] = 'CHANGED10';
	const oldText = oldLines.join('\n') + '\n';
	const newText = newLines.join('\n') + '\n';

	const withDefaultContext = computeDiffLines(oldText, newText);
	const withNoContext = computeDiffLines(oldText, newText, {context: 0});

	t.true(withDefaultContext.filter(l => l.kind === 'context').length > 0);
	t.is(withNoContext.filter(l => l.kind === 'context').length, 0);
});
