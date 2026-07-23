import test from 'ava';
import {candidateSignature, recoverWithFallback} from './fallback';
import type {
	PatternStore,
	RawFix,
	RecoveryContext,
	RecoveryObservation,
} from './types';

console.log('\ntool-call-recovery/fallback.spec.ts');

const CTX: RecoveryContext = {
	toolNames: ['execute_bash', 'read_file', 'write_file', 'grep'],
};

// A name too far from any tool → the deterministic core returns unrecoverable,
// so the fallback tiers engage.
const UNRECOVERABLE =
	'<function=totally_unknown_widget>{"path":"a.ts"}</function>';

test('no fallback wired → deterministic result stands unchanged', async t => {
	const r = await recoverWithFallback(UNRECOVERABLE, CTX);
	t.is(r.outcomes.length, 1);
	t.is(r.outcomes[0].kind, 'unrecoverable');
});

test('tier 3: LLM fallback recovers + records to the store; confidence llm-repaired', async t => {
	const recorded: RecoveryObservation[] = [];
	let llmCalls = 0;
	const store: PatternStore = {
		match: () => null,
		record: o => recorded.push(o),
	};
	const llmRepair = async (): Promise<RawFix> => {
		llmCalls++;
		return {name: 'read_file', arguments: {path: 'a.ts'}};
	};
	const r = await recoverWithFallback(UNRECOVERABLE, CTX, {
		patternStore: store,
		llmRepair,
		now: () => 123,
	});
	t.is(llmCalls, 1);
	t.is(r.outcomes[0].kind, 'recovered');
	if (r.outcomes[0].kind === 'recovered') {
		t.is(r.outcomes[0].call.name, 'read_file');
		t.is(r.outcomes[0].call.provenance.confidence, 'llm-repaired');
	}
	// the LLM fix graduated into the store (learning loop)
	t.is(recorded.length, 1);
	t.is(recorded[0].method, 'llm');
	t.is(recorded[0].at, 123);
});

test('tier 2: a learned store hit replays for free (no LLM call); confidence learned', async t => {
	let llmCalls = 0;
	const store: PatternStore = {
		match: () => ({name: 'read_file', arguments: {path: 'a.ts'}}),
		record: () => {},
	};
	const r = await recoverWithFallback(UNRECOVERABLE, CTX, {
		patternStore: store,
		llmRepair: async () => {
			llmCalls++;
			return null;
		},
	});
	t.is(llmCalls, 0, 'learned hit must short-circuit before the LLM');
	t.is(r.outcomes[0].kind, 'recovered');
	if (r.outcomes[0].kind === 'recovered') {
		t.is(r.outcomes[0].call.provenance.confidence, 'learned');
	}
});

test('an LLM fix with an unregistered tool name is rejected → stays unrecoverable', async t => {
	const r = await recoverWithFallback(UNRECOVERABLE, CTX, {
		llmRepair: async () => ({name: 'not_a_real_tool', arguments: {}}),
	});
	t.is(r.outcomes[0].kind, 'unrecoverable');
});

test('deterministically-recovered candidates never reach the LLM fallback', async t => {
	let llmCalls = 0;
	const good =
		'<function=execute_bparameter name="command">echo hi</parameter></function>';
	const r = await recoverWithFallback(good, CTX, {
		llmRepair: async () => {
			llmCalls++;
			return null;
		},
	});
	t.is(r.outcomes[0].kind, 'recovered');
	t.is(llmCalls, 0, 'deterministic success must not spend an LLM call');
});

test('candidateSignature collapses superficially-different repeats of the same shape', t => {
	const a = {
		rawName: 'execute_bparameter',
		rawArgs: 'name="command">echo A</parameter>',
		format: 'attribute-merged' as const,
		span: {start: 0, end: 1, text: 'x'},
	};
	const b = {
		rawName: 'execute_bparameter',
		rawArgs: 'name="command">echo TOTALLY DIFFERENT VALUE</parameter>',
		format: 'attribute-merged' as const,
		span: {start: 5, end: 9, text: 'y'},
	};
	t.is(candidateSignature(a), candidateSignature(b));
});
