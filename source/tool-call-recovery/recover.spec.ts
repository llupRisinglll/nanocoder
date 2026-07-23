console.log('\ntool-call-recovery/recover.spec.ts');

import test from 'ava';
import {recoverToolCalls} from './recover';
import type {RecoveryContext} from './types';

const TOOLS = ['execute_bash', 'read_file', 'write_file', 'list_dir'];

test('end-to-end: the attribute-merged README example recovers cleanly', t => {
	const text = `<tool_call>
<function=execute_bparameter name="command">lsof -i :4000 -i :4001 2>/dev/null | grep LISTEN</parameter>
</function>
</tool_call>`;
	const context: RecoveryContext = {toolNames: TOOLS};
	const result = recoverToolCalls(text, context);

	t.true(result.hadCandidates);
	t.is(result.outcomes.length, 1);

	const outcome = result.outcomes[0];
	t.is(outcome.kind, 'recovered');
	if (outcome.kind !== 'recovered') return;

	// Fuzzy-matched back to the real tool, args salvaged from the XML params.
	t.is(outcome.call.name, 'execute_bash');
	t.is(
		outcome.call.arguments.command,
		'lsof -i :4000 -i :4001 2>/dev/null | grep LISTEN',
	);

	// Name was fuzzed (execute_bparameter → execute_bash) but no schema was
	// supplied, so no arg-repair notes → confidence is 'fuzzy-name'.
	t.is(outcome.call.provenance.confidence, 'fuzzy-name');
	t.is(outcome.call.provenance.originalName, 'execute_bparameter');
	t.is(outcome.call.provenance.notes.length, 1);
	t.true(outcome.call.provenance.notes[0].includes('execute_bash'));
	t.is(outcome.call.provenance.rawText, text);

	// The whole leaked span is stripped; nothing renders as a final answer.
	t.is(result.strippedText, '');
});

test('exact name + no repairs → confidence "exact"', t => {
	const text = `{"tool": "read_file", "arguments": {"path": "/etc/hosts"}}`;
	const result = recoverToolCalls(text, {toolNames: TOOLS});
	const outcome = result.outcomes[0];
	t.is(outcome.kind, 'recovered');
	if (outcome.kind !== 'recovered') return;
	t.is(outcome.call.name, 'read_file');
	t.is(outcome.call.provenance.confidence, 'exact');
	t.is(outcome.call.provenance.originalName, undefined);
	t.deepEqual(outcome.call.provenance.notes, []);
});

test('fuzzy name + schema-driven arg repair → "fuzzy-and-repaired"', t => {
	// Garbled name "read_flie" + a schema wanting a numeric "depth" as number.
	const text = `<function=read_flie>{"path": "/tmp", "depth": "2"}</function>`;
	const context: RecoveryContext = {
		toolNames: ['read_file'],
		schemas: {
			read_file: {
				type: 'object',
				properties: {
					path: {type: 'string'},
					depth: {type: 'integer'},
				},
			},
		},
	};
	const result = recoverToolCalls(text, context);
	const outcome = result.outcomes[0];
	t.is(outcome.kind, 'recovered');
	if (outcome.kind !== 'recovered') return;
	t.is(outcome.call.name, 'read_file');
	t.is(outcome.call.arguments.depth, 2); // coerced string → number
	t.is(outcome.call.provenance.confidence, 'fuzzy-and-repaired');
	// Fuzzy note leads, arg-repair note follows.
	t.true(outcome.call.provenance.notes.length >= 2);
	t.true(outcome.call.provenance.notes[0].startsWith('fuzzy name'));
});

test('ambiguous: a name equidistant from two tools refuses to guess', t => {
	// "reab_file" is one edit from BOTH read_file and reab_file-like siblings.
	const text = `<function=read_fole>{"path": "x"}</function>`;
	const context: RecoveryContext = {toolNames: ['read_file', 'read_role']};
	const result = recoverToolCalls(text, context);
	const outcome = result.outcomes[0];
	t.is(outcome.kind, 'ambiguous');
	if (outcome.kind !== 'ambiguous') return;
	t.is(outcome.rawName, 'read_fole');
	t.true(outcome.matches.includes('read_file'));
	t.true(outcome.matches.includes('read_role'));
	// Even an ambiguous candidate's span is stripped from the text.
	t.is(result.strippedText, '');
});

test('unrecoverable: no tool within threshold', t => {
	const text = `<function=completely_unrelated_xyz>{"a": 1}</function>`;
	const result = recoverToolCalls(text, {toolNames: TOOLS});
	const outcome = result.outcomes[0];
	t.is(outcome.kind, 'unrecoverable');
	if (outcome.kind !== 'unrecoverable') return;
	t.true(outcome.reason.includes('completely_unrelated_xyz'));
	t.is(outcome.rawText, text);
});

test('unrecoverable: name matches but args are not salvageable into an object', t => {
	// Valid name, but the args blob is a bare array — not an argument map.
	const text = `<function=read_file>["not", "an", "object"]</function>`;
	const result = recoverToolCalls(text, {toolNames: TOOLS});
	const outcome = result.outcomes[0];
	t.is(outcome.kind, 'unrecoverable');
	if (outcome.kind !== 'unrecoverable') return;
	t.true(outcome.reason.includes('read_file'));
});

test('multi-candidate: mixed outcomes, only surrounding prose survives strip', t => {
	const text = [
		'Prose before.',
		'<function=execute_bparameter name="command">whoami</parameter></function>',
		'middle prose',
		'<function=totally_unknown_tool>{"x":1}</function>',
		'Prose after.',
	].join('\n');
	const result = recoverToolCalls(text, {toolNames: TOOLS});
	t.is(result.outcomes.length, 2);
	t.is(result.outcomes[0].kind, 'recovered');
	t.is(result.outcomes[1].kind, 'unrecoverable');
	// Both spans removed; the three prose lines remain (interior newlines kept).
	t.true(result.strippedText.startsWith('Prose before.'));
	t.true(result.strippedText.endsWith('Prose after.'));
	t.true(result.strippedText.includes('middle prose'));
	t.false(result.strippedText.includes('whoami'));
	t.false(result.strippedText.includes('totally_unknown_tool'));
});

test('no candidates: text untouched, hadCandidates false', t => {
	const text = 'Just a normal answer with nothing tool-shaped.';
	const result = recoverToolCalls(text, {toolNames: TOOLS});
	t.false(result.hadCandidates);
	t.is(result.outcomes.length, 0);
	// strippedText is the trimmed original (no spans removed).
	t.is(result.strippedText, text);
});
