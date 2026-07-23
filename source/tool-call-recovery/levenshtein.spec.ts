import test from 'ava';
console.log('\ntool-call-recovery/levenshtein.spec.ts');

import {levenshtein, normalizedDistance} from './levenshtein.js';

test('identical strings have distance 0', t => {
	t.is(levenshtein('execute_bash', 'execute_bash'), 0);
	t.is(levenshtein('', ''), 0);
});

test('single edit is distance 1', t => {
	t.is(levenshtein('kitten', 'kittes'), 1); // substitution
	t.is(levenshtein('cat', 'cats'), 1); // insertion
	t.is(levenshtein('cats', 'cat'), 1); // deletion
});

test('classic multi-edit distance', t => {
	t.is(levenshtein('kitten', 'sitting'), 3);
	t.is(levenshtein('flaw', 'lawn'), 2);
});

test('empty string equals length of the other', t => {
	t.is(levenshtein('', 'abc'), 3);
	t.is(levenshtein('abc', ''), 3);
});

test('distance is symmetric', t => {
	t.is(levenshtein('write_file', 'read_file'), levenshtein('read_file', 'write_file'));
});

test('normalizedDistance is 0 when equal', t => {
	t.is(normalizedDistance('foo', 'foo'), 0);
	t.is(normalizedDistance('', ''), 0); // guarded max(...,1) avoids NaN
});

test('normalizedDistance stays within 0..1 bounds', t => {
	for (const [a, b] of [
		['execute_bparameter', 'execute_bash'],
		['grep', 'ripgrep'],
		['', 'anything'],
		['totally', 'different'],
	] as const) {
		const d = normalizedDistance(a, b);
		t.true(d >= 0 && d <= 1, `${a} vs ${b} -> ${d}`);
	}
});

test('normalizedDistance scales by longer length', t => {
	// one substitution out of 3 chars
	t.is(normalizedDistance('abc', 'abd'), 1 / 3);
	// full mismatch of equal length is 1
	t.is(normalizedDistance('ab', 'cd'), 1);
});
