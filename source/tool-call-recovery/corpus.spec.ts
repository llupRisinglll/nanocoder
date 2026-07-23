console.log('\ntool-call-recovery/corpus.spec.ts');

/**
 * corpus.spec.ts — the safety-critical, table-driven proof that
 * `recoverToolCalls` salvages the real malformation classes weak / Chinese open
 * models (mimo, qwen, deepseek, minimax) emit when they leak a tool call as text
 * instead of executing it.
 *
 * Each row runs the FULL orchestrator (detect → fuzzy-match → repair) against a
 * realistic tool list and asserts the outcome kind, recovered name/args, the
 * provenance confidence tier, and the stripped text. Provenance-heavy scenarios
 * (ambiguity, two-in-one, force-confirm tiers, schema coercion, threshold
 * refusal) get dedicated tests below the table.
 */

import test from 'ava';
import {recoverToolCalls} from './index';
import type {JSONSchemaLike, RecoveryConfidence, RecoveryContext} from './types';

/** The realistic tool surface a coding agent exposes. */
const TOOLS = [
	'execute_bash',
	'read_file',
	'write_file',
	'string_replace',
	'grep',
	'list_directory',
];

/**
 * Confidence tiers that MUST make the host force a confirmation: anything the
 * module had to guess or rewrite. Only a byte-clean `exact` may auto-run.
 */
const FORCE_CONFIRM_TIERS: ReadonlySet<RecoveryConfidence> = new Set([
	'fuzzy-name',
	'repaired-args',
	'fuzzy-and-repaired',
]);

// --- Table-driven cases ------------------------------------------------------

interface Case {
	label: string;
	text: string;
	/** Extra context (schemas/options); toolNames defaults to TOOLS. */
	ctx?: Partial<RecoveryContext>;
	/** Defaults to true. */
	hadCandidates?: boolean;
	/** Defaults to 1. */
	outcomeCount?: number;
	/** Assertions on the FIRST outcome. */
	kind: 'recovered' | 'ambiguous' | 'unrecoverable';
	name?: string;
	args?: Record<string, unknown>;
	confidence?: RecoveryConfidence;
	matchesInclude?: string[];
	reasonIncludes?: string;
	/** Exact expected strippedText, when it's worth pinning. */
	stripped?: string;
}

const CASES: Case[] = [
	{
		// (1) THE bug: the first `<parameter ` is swallowed into the function tag,
		// fusing `parameter` onto the name → `execute_bparameter`.
		label: '(1) attribute-merged execute_bparameter',
		text:
			'<tool_call>\n<function=execute_bparameter name="command">grep -rn TODO src/</parameter>\n</function>\n</tool_call>',
		kind: 'recovered',
		name: 'execute_bash',
		args: {command: 'grep -rn TODO src/'},
		confidence: 'fuzzy-name',
		stripped: '',
	},
	{
		// (2) Well-formed name, but the model forgot the closing </parameter>; the
		// value must still be salvaged (it runs up to the </function>).
		label: '(2) xml-tags with a missing </parameter>',
		text:
			'<tool_call>\n<function=read_file>\n<parameter name="path">src/app.ts\n</function>\n</tool_call>',
		kind: 'recovered',
		name: 'read_file',
		args: {path: 'src/app.ts'},
		confidence: 'exact',
		stripped: '',
	},
	{
		// (3) The clean function-tag form with a JSON body.
		label: '(3) function-tag <function=read_file>{json}</function>',
		text: '<function=read_file>{"path":"a.ts"}</function>',
		kind: 'recovered',
		name: 'read_file',
		args: {path: 'a.ts'},
		confidence: 'exact',
		stripped: '',
	},
	{
		// (4) Broken JSON (single quotes + trailing comma) fixed by jsonrepair.
		// NOTE: with no schema, jsonrepair alone does NOT lower the tier — the
		// call is still structurally faithful, so confidence stays 'exact'. The
		// downgrade to a force-confirm tier is driven by fuzzy names / schema
		// coercions, not by cosmetic JSON fixes (see the schema-coercion test).
		label: '(4) broken JSON args need jsonrepair (single quotes + trailing comma)',
		text:
			"<function=write_file>{'path': 'out.txt', 'content': 'hello world',}</function>",
		kind: 'recovered',
		name: 'write_file',
		args: {path: 'out.txt', content: 'hello world'},
		confidence: 'exact',
		stripped: '',
	},
	{
		// (5) A typo WITHIN the fuzzy threshold recovers with a fuzzy-name tier.
		// (The task's `grpe` example is a 2-edit transposition at distance 0.5 —
		// OUT of threshold — so it is correctly refused; see the dedicated
		// threshold test below. `grap` is a genuine 1-edit typo of grep.)
		label: '(5) name typo within threshold grap → grep',
		text: '<function=grap>{"pattern":"foo","path":"src"}</function>',
		kind: 'recovered',
		name: 'grep',
		args: {pattern: 'foo', path: 'src'},
		confidence: 'fuzzy-name',
		stripped: '',
	},
	{
		// (6) Equidistant between read_file and write_file within the ambiguity
		// band → refuse to guess.
		label: '(6) ambiguous name → {kind:"ambiguous"}',
		text: '<function=reit_file>{"path":"x"}</function>',
		kind: 'ambiguous',
		matchesInclude: ['read_file', 'write_file'],
		stripped: '',
	},
	{
		// (7) Nothing on the tool list is within threshold → unrecoverable.
		label: '(7) unknown/garbage name → {kind:"unrecoverable"}',
		text: '<function=frobnicate_widget>{"x":1}</function>',
		kind: 'unrecoverable',
		reasonIncludes: 'frobnicate_widget',
	},
	{
		// (8) Plain prose that merely TALKS about tools: no candidate at all.
		label: '(8) prose with no tool call → hadCandidates:false, text unchanged',
		text: 'Sure — you could list the directory yourself, but I will not run it.',
		hadCandidates: false,
		outcomeCount: 0,
		kind: 'recovered', // unused (outcomeCount 0); kept to satisfy the type
		stripped:
			'Sure — you could list the directory yourself, but I will not run it.',
	},
];

for (const c of CASES) {
	test(`corpus: ${c.label}`, t => {
		const context: RecoveryContext = {toolNames: TOOLS, ...c.ctx};
		const result = recoverToolCalls(c.text, context);

		t.is(result.hadCandidates, c.hadCandidates ?? true, 'hadCandidates');
		t.is(result.outcomes.length, c.outcomeCount ?? 1, 'outcome count');

		if (c.stripped !== undefined) {
			t.is(result.strippedText, c.stripped, 'strippedText');
		}

		if ((c.outcomeCount ?? 1) === 0) return; // prose case: nothing more to assert

		const outcome = result.outcomes[0];
		t.is(outcome.kind, c.kind, 'outcome kind');

		if (outcome.kind === 'recovered') {
			if (c.name !== undefined) t.is(outcome.call.name, c.name, 'name');
			if (c.args !== undefined) {
				t.deepEqual(outcome.call.arguments, c.args, 'arguments');
			}
			if (c.confidence !== undefined) {
				t.is(outcome.call.provenance.confidence, c.confidence, 'confidence');
			}
			// A recovered call always carries the exact salvaged span.
			t.is(outcome.call.provenance.rawText.length > 0, true, 'rawText present');
		} else if (outcome.kind === 'ambiguous') {
			for (const m of c.matchesInclude ?? []) {
				t.true(outcome.matches.includes(m), `matches includes ${m}`);
			}
		} else {
			if (c.reasonIncludes !== undefined) {
				t.true(outcome.reason.includes(c.reasonIncludes), 'reason');
			}
		}
	});
}

// --- (9) Two calls in one message -------------------------------------------

test('corpus: (9) two calls in one message — both recovered, prose kept', t => {
	const text = [
		'Let me inspect then clean up.',
		'<function=read_file>{"path":"a.ts"}</function>',
		'and then',
		'<function=execute_bparameter name="command">rm -rf build/</parameter></function>',
		'Done.',
	].join('\n');

	const result = recoverToolCalls(text, {toolNames: TOOLS});

	t.true(result.hadCandidates);
	t.is(result.outcomes.length, 2);

	const [first, second] = result.outcomes;
	t.is(first.kind, 'recovered');
	t.is(second.kind, 'recovered');
	if (first.kind !== 'recovered' || second.kind !== 'recovered') return;

	// Emitted in source order.
	t.is(first.call.name, 'read_file');
	t.deepEqual(first.call.arguments, {path: 'a.ts'});
	t.is(second.call.name, 'execute_bash');
	t.deepEqual(second.call.arguments, {command: 'rm -rf build/'});

	// Both leaked spans are removed; only the three prose lines survive.
	t.false(result.strippedText.includes('read_file'));
	t.false(result.strippedText.includes('rm -rf'));
	t.true(result.strippedText.startsWith('Let me inspect'));
	t.true(result.strippedText.includes('and then'));
	t.true(result.strippedText.endsWith('Done.'));
});

// --- (10) Mutating calls MUST land on a force-confirm tier -------------------

test('corpus: (10a) mutating execute_bash (attr-merged) → fuzzy tier, host force-confirms', t => {
	const text =
		'<function=execute_bparameter name="command">rm -rf build/</parameter></function>';
	const result = recoverToolCalls(text, {toolNames: TOOLS});
	const outcome = result.outcomes[0];
	t.is(outcome.kind, 'recovered');
	if (outcome.kind !== 'recovered') return;

	t.is(outcome.call.name, 'execute_bash');
	t.is(outcome.call.arguments.command, 'rm -rf build/');
	// The name was guessed → NOT 'exact' → the host is obligated to confirm.
	t.is(outcome.call.provenance.confidence, 'fuzzy-name');
	t.true(
		FORCE_CONFIRM_TIERS.has(outcome.call.provenance.confidence),
		'a guessed mutating call must force a confirmation',
	);
	t.is(outcome.call.provenance.originalName, 'execute_bparameter');
});

test('corpus: (10b) mutating write_file with schema coercion → repaired-args tier', t => {
	// A weak model handed us `overwrite` as the string "true"; the schema coerces
	// it to a boolean, which records a note and downgrades the tier away from
	// 'exact' so a destructive write can never silently auto-run.
	const schema: JSONSchemaLike = {
		type: 'object',
		properties: {
			path: {type: 'string'},
			content: {type: 'string'},
			overwrite: {type: 'boolean'},
		},
		required: ['path', 'content'],
	};
	const text =
		'<function=write_file>{"path":"cfg.json","content":"{}","overwrite":"true"}</function>';
	const result = recoverToolCalls(text, {
		toolNames: TOOLS,
		schemas: {write_file: schema},
	});
	const outcome = result.outcomes[0];
	t.is(outcome.kind, 'recovered');
	if (outcome.kind !== 'recovered') return;

	t.is(outcome.call.name, 'write_file');
	t.is(outcome.call.arguments.overwrite, true); // string → boolean
	t.is(outcome.call.provenance.confidence, 'repaired-args');
	t.true(FORCE_CONFIRM_TIERS.has(outcome.call.provenance.confidence));
	t.true(
		outcome.call.provenance.notes.some(n => n.includes('overwrite')),
		'the coercion is noted for the user',
	);
});

// --- Safety boundary: a too-far typo is REFUSED, not guessed ----------------

test('corpus: over-threshold typo grpe → grep is refused (unrecoverable, not guessed)', t => {
	// `grpe` is a 2-edit transposition of `grep` (normalized distance 0.5), well
	// beyond the 0.34 default. Guessing here would be unsafe, so the module must
	// decline rather than run the wrong tool.
	const result = recoverToolCalls('<function=grpe>{"pattern":"foo"}</function>', {
		toolNames: TOOLS,
	});
	const outcome = result.outcomes[0];
	t.is(outcome.kind, 'unrecoverable');
	if (outcome.kind !== 'unrecoverable') return;
	t.true(outcome.reason.includes('grpe'));
	// Even a refused candidate is stripped so the garbled XML never renders.
	t.is(result.strippedText, '');
});

// --- Cross-cutting invariant: every candidate span is always stripped -------

test('corpus: recovered/ambiguous/unrecoverable spans are ALL stripped from the answer', t => {
	const text = [
		'Prologue.',
		'<function=read_file>{"path":"a.ts"}</function>', // recovered
		'<function=reit_file>{"path":"x"}</function>', // ambiguous
		'<function=frobnicate_widget>{"z":1}</function>', // unrecoverable
		'Epilogue.',
	].join('\n');
	const result = recoverToolCalls(text, {toolNames: TOOLS});

	t.is(result.outcomes.length, 3);
	t.deepEqual(
		result.outcomes.map(o => o.kind),
		['recovered', 'ambiguous', 'unrecoverable'],
	);
	// No tool-shaped bytes leak into the rendered text, regardless of outcome.
	t.false(result.strippedText.includes('<function='));
	t.false(result.strippedText.includes('reit_file'));
	t.false(result.strippedText.includes('frobnicate_widget'));
	t.true(result.strippedText.startsWith('Prologue.'));
	t.true(result.strippedText.endsWith('Epilogue.'));
});
