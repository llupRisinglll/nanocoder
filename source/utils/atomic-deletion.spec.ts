import test from 'ava';
import type {InputState, PastePlaceholderContent} from '../types/hooks';
import {PlaceholderType} from '../types/hooks';
import {
	findPlaceholderAtPosition,
	findSpanForBackspace,
	getPlaceholderSpans,
	handleAtomicDeletion,
	snapOutOfPlaceholder,
	wouldPartiallyDeletePlaceholder,
} from './atomic-deletion';

console.log(`\natomic-deletion.spec.ts`);

// Tests for atomic placeholder deletion
test('handleAtomicDeletion removes placeholder when backspaced', t => {
	const previousState: InputState = {
		displayValue: 'Analyze this: [Paste #123: 500 chars] code',
		placeholderContent: {
			'123': {
				type: PlaceholderType.PASTE,
				displayText: '[Paste #123: 500 chars]',
				content: 'console.log("hello world");',
				originalSize: 500,
			} as PastePlaceholderContent,
		},
	};

	// Simulate backspacing from the end of the placeholder
	const newText = 'Analyze this: [Paste #123: 500 char code';

	const result = handleAtomicDeletion(previousState, newText);

	t.truthy(result);
	t.is(result!.displayValue, 'Analyze this:  code');
	t.deepEqual(result!.placeholderContent, {});
});

test('handleAtomicDeletion removes placeholder when deleted from middle', t => {
	const previousState: InputState = {
		displayValue: 'Before [Paste #456: 200 chars] after',
		placeholderContent: {
			'456': {
				type: PlaceholderType.PASTE,
				displayText: '[Paste #456: 200 chars]',
				content: 'function test() { return true; }',
				originalSize: 200,
			} as PastePlaceholderContent,
		},
	};

	// Simulate deleting part of the placeholder
	const newText = 'Before [Paste #456: 200 ch after';

	const result = handleAtomicDeletion(previousState, newText);

	t.truthy(result);
	t.is(result!.displayValue, 'Before  after');
	t.deepEqual(result!.placeholderContent, {});
});

test('handleAtomicDeletion preserves other placeholders', t => {
	const previousState: InputState = {
		displayValue:
			'First [Paste #111: 100 chars] second [Paste #222: 200 chars]',
		placeholderContent: {
			'111': {
				type: PlaceholderType.PASTE,
				displayText: '[Paste #111: 100 chars]',
				content: 'first content',
				originalSize: 100,
			} as PastePlaceholderContent,
			'222': {
				type: PlaceholderType.PASTE,
				displayText: '[Paste #222: 200 chars]',
				content: 'second content',
				originalSize: 200,
			} as PastePlaceholderContent,
		},
	};

	// Delete part of first placeholder
	const newText = 'First [Paste #111: 100 ch second [Paste #222: 200 chars]';

	const result = handleAtomicDeletion(previousState, newText);

	t.truthy(result);
	t.is(result!.displayValue, 'First  second [Paste #222: 200 chars]');
	t.deepEqual(result!.placeholderContent, {
		'222': {
			type: PlaceholderType.PASTE,
			displayText: '[Paste #222: 200 chars]',
			content: 'second content',
			originalSize: 200,
		} as PastePlaceholderContent,
	});
});

test('handleAtomicDeletion returns null for normal deletions', t => {
	const previousState: InputState = {
		displayValue: 'Normal text here',
		placeholderContent: {},
	};

	const newText = 'Normal text her';

	const result = handleAtomicDeletion(previousState, newText);

	t.is(result, null);
});

test('handleAtomicDeletion returns null for additions', t => {
	const previousState: InputState = {
		displayValue: 'Short text',
		placeholderContent: {},
	};

	const newText = 'Short text with more';

	const result = handleAtomicDeletion(previousState, newText);

	t.is(result, null);
});

test('findPlaceholderAtPosition finds placeholder ID', t => {
	const text = 'Before [Paste #789: 300 chars] after';

	// Position inside the placeholder
	const result1 = findPlaceholderAtPosition(text, 10); // Inside "[Paste #789: 300 chars]"
	t.is(result1, '789');

	// Position outside the placeholder
	const result2 = findPlaceholderAtPosition(text, 0); // In "Before"
	t.is(result2, null);

	// Position after placeholder
	const result3 = findPlaceholderAtPosition(text, 35); // In "after"
	t.is(result3, null);
});

test('wouldPartiallyDeletePlaceholder detects partial deletion', t => {
	const text = 'Text [Paste #123: 100 chars] more';
	//       01234567890123456789012345678901234
	//       0         1         2         3
	// Placeholder is at position 5-28 (length 23)

	// Partial deletion from middle of placeholder
	const result1 = wouldPartiallyDeletePlaceholder(text, 8, 5); // Delete "Paste"
	t.true(result1);

	// Complete deletion of placeholder - delete from position 5, length 23
	const result2 = wouldPartiallyDeletePlaceholder(text, 5, 23); // Delete entire "[Paste #123: 100 chars]"
	t.false(result2);

	// Deletion outside placeholder
	const result3 = wouldPartiallyDeletePlaceholder(text, 0, 4); // Delete "Text"
	t.false(result3);
});

// Integration test showing complete flow
test('atomic deletion works with multiple placeholders', t => {
	const previousState: InputState = {
		displayValue:
			'Compare [Paste #111: 50 chars] with [Paste #222: 100 chars] output',
		placeholderContent: {
			'111': {
				type: PlaceholderType.PASTE,
				displayText: '[Paste #111: 50 chars]',
				content: 'first code block',
				originalSize: 50,
			} as PastePlaceholderContent,
			'222': {
				type: PlaceholderType.PASTE,
				displayText: '[Paste #222: 100 chars]',
				content: 'second code block with more content',
				originalSize: 100,
			} as PastePlaceholderContent,
		},
	};

	// Delete part of second placeholder
	const newText =
		'Compare [Paste #111: 50 chars] with [Paste #222: 100 ch output';

	const result = handleAtomicDeletion(previousState, newText);

	t.truthy(result);
	t.is(result!.displayValue, 'Compare [Paste #111: 50 chars] with  output');
	t.deepEqual(result!.placeholderContent, {
		'111': {
			type: PlaceholderType.PASTE,
			displayText: '[Paste #111: 50 chars]',
			content: 'first code block',
			originalSize: 50,
		} as PastePlaceholderContent,
	});
});

// --- Cursor atomicity helpers ---

test('getPlaceholderSpans finds all placeholder spans', t => {
	const text = 'a [Paste #1: 818 chars] b [Paste #2: 42 chars]';
	const spans = getPlaceholderSpans(text);

	t.is(spans.length, 2);
	t.is(text.slice(spans[0].start, spans[0].end), '[Paste #1: 818 chars]');
	t.is(text.slice(spans[1].start, spans[1].end), '[Paste #2: 42 chars]');
});

test('getPlaceholderSpans returns empty for plain text', t => {
	t.deepEqual(getPlaceholderSpans('no placeholders here'), []);
});

test('snapOutOfPlaceholder left snaps to span start', t => {
	const text = 'hi [Paste #1: 818 chars] bye';
	// Offset 10 is inside the placeholder (span starts at 3)
	t.is(snapOutOfPlaceholder(text, 10, 'left'), 3);
});

test('snapOutOfPlaceholder right snaps to span end', t => {
	const text = 'hi [Paste #1: 818 chars] bye';
	t.is(snapOutOfPlaceholder(text, 10, 'right'), 24);
});

test('snapOutOfPlaceholder nearest picks closer boundary', t => {
	const text = '[Paste #1: 818 chars]';
	t.is(snapOutOfPlaceholder(text, 2, 'nearest'), 0);
	t.is(snapOutOfPlaceholder(text, 19, 'nearest'), 21);
});

test('snapOutOfPlaceholder leaves boundary and outside offsets alone', t => {
	const text = 'hi [Paste #1: 818 chars] bye';
	t.is(snapOutOfPlaceholder(text, 0, 'left'), 0);
	t.is(snapOutOfPlaceholder(text, 3, 'left'), 3);
	t.is(snapOutOfPlaceholder(text, 24, 'right'), 24);
	t.is(snapOutOfPlaceholder(text, 26, 'nearest'), 26);
});

test('findSpanForBackspace matches cursor at span end or inside', t => {
	const text = 'hi [Paste #1: 818 chars] bye';
	const atEnd = findSpanForBackspace(text, 24);
	t.truthy(atEnd);
	t.is(atEnd!.start, 3);
	t.is(atEnd!.end, 24);

	const inside = findSpanForBackspace(text, 10);
	t.truthy(inside);
	t.is(inside!.start, 3);
});

test('findSpanForBackspace returns null outside placeholders', t => {
	const text = 'hi [Paste #1: 818 chars] bye';
	t.is(findSpanForBackspace(text, 3), null);
	t.is(findSpanForBackspace(text, 26), null);
	t.is(findSpanForBackspace(text, 2), null);
});
