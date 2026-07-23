import test from 'ava';
console.log('\ntool-call-recovery/fuzzy-name.spec.ts');

import {fuzzyMatchToolName} from './fuzzy-name.js';

/** The realistic registered tool set weak models corrupt against. */
const TOOLS = ['execute_bash', 'read_file', 'write_file', 'string_replace', 'grep'];

test('artifact-fused name recovers via suffix stripping', t => {
	// `execute_bparameter` = `execute_b` + fused `parameter`. Only the STRIPPED
	// form falls inside the threshold, so the strip is load-bearing here.
	const result = fuzzyMatchToolName('execute_bparameter', TOOLS);
	t.deepEqual(
		result && 'name' in result ? result.name : result,
		'execute_bash',
	);
});

test('without the artifact strip the same name does not match', t => {
	// Proves the recovery above depends on stripping, not on raw fuzziness.
	const result = fuzzyMatchToolName('execute_bparameter', TOOLS, {
		nameArtifacts: [],
	});
	t.is(result, null);
});

test('exact name matches with distance 0', t => {
	t.deepEqual(fuzzyMatchToolName('read_file', TOOLS), {
		name: 'read_file',
		distance: 0,
	});
});

test('a genuine typo matches the nearest tool', t => {
	const result = fuzzyMatchToolName('read_flie', TOOLS);
	t.true(result !== null && 'name' in result && result.name === 'read_file');
});

test('two near-equal candidates are reported as ambiguous', t => {
	// `foo_bat` is one substitution from BOTH tools -> refuse to guess.
	const result = fuzzyMatchToolName('foo_bat', ['foo_bar', 'foo_baz']);
	t.truthy(result && 'ambiguous' in result);
	if (result && 'ambiguous' in result) {
		t.deepEqual(result.ambiguous.sort(), ['foo_bar', 'foo_baz']);
	}
});

test('a clearly closer tool wins over a distant runner-up', t => {
	// `write_fil` is 1 edit from write_file, far from everything else.
	const result = fuzzyMatchToolName('write_fil', TOOLS);
	t.true(result !== null && 'name' in result && result.name === 'write_file');
});

test('nothing within threshold returns null', t => {
	t.is(fuzzyMatchToolName('xyzzy', TOOLS), null);
});

test('matching is case-insensitive on both sides', t => {
	const result = fuzzyMatchToolName('GREP', TOOLS);
	t.deepEqual(result, {name: 'grep', distance: 0});
});

test('a tighter threshold rejects a borderline match', t => {
	// read_flie -> read_file is ~0.22; a 0.1 ceiling excludes it.
	t.is(fuzzyMatchToolName('read_flie', TOOLS, {maxNameDistance: 0.1}), null);
});
