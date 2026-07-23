import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'ava';
import {candidateSignature} from '@/tool-call-recovery';
import {RecoveryDatasetStore} from './dataset-store';
import {parseFix} from './llm-repair';

console.log('\ntool-call-recovery-host/host.spec.ts');

const cand = {
	rawName: 'execute_bparameter',
	rawArgs: 'name="command">echo hi</parameter>',
	format: 'attribute-merged' as const,
	span: {start: 0, end: 5, text: 'x'},
};
const ctx = {toolNames: ['execute_bash', 'read_file']};

test('dataset store: record a fix → match replays it; recentFixes lists it', t => {
	const dir = mkdtempSync(join(tmpdir(), 'tcr-'));
	const store = new RecoveryDatasetStore(join(dir, 'ds.jsonl'));
	t.is(store.match(cand, ctx), null, 'empty store → no match');
	store.logEvent({
		ts: 1,
		rawText: cand.span.text,
		signature: candidateSignature(cand),
		format: cand.format,
		recovered: true,
		method: 'llm',
		fix: {name: 'execute_bash', arguments: {command: 'echo hi'}},
	});
	const m = store.match(cand, ctx);
	t.truthy(m);
	t.is(m?.name, 'execute_bash');
	t.is(store.recentFixes(5).length, 1);
	rmSync(dir, {recursive: true, force: true});
});

test('dataset store: refuses a stored fix whose tool is no longer registered', t => {
	const dir = mkdtempSync(join(tmpdir(), 'tcr-'));
	const store = new RecoveryDatasetStore(join(dir, 'ds.jsonl'));
	store.logEvent({
		ts: 1,
		rawText: cand.span.text,
		signature: candidateSignature(cand),
		recovered: true,
		fix: {name: 'gone_tool', arguments: {}},
	});
	t.is(store.match(cand, ctx), null);
	rmSync(dir, {recursive: true, force: true});
});

test('dataset store: an unrecovered failure is logged but is not a match', t => {
	const dir = mkdtempSync(join(tmpdir(), 'tcr-'));
	const store = new RecoveryDatasetStore(join(dir, 'ds.jsonl'));
	store.logEvent({
		ts: 1,
		rawText: cand.span.text,
		signature: candidateSignature(cand),
		recovered: false,
		error: 'could not salvage',
	});
	t.is(store.match(cand, ctx), null);
	t.is(store.recentFixes(5).length, 0, 'failures are data, not replayable fixes');
	rmSync(dir, {recursive: true, force: true});
});

test('parseFix: extracts a call from messy LLM output (prose + fence + trailing comma)', t => {
	const out = parseFix(
		'Sure!\n```json\n{"name":"read_file","arguments":{"path":"a.ts",}}\n```',
		['read_file', 'execute_bash'],
	);
	t.truthy(out);
	t.is(out?.name, 'read_file');
	t.deepEqual(out?.arguments, {path: 'a.ts'});
});

test('parseFix: rejects an unregistered tool and non-JSON output', t => {
	t.is(parseFix('{"name":"nope","arguments":{}}', ['read_file']), null);
	t.is(parseFix('no json here at all', ['read_file']), null);
	t.is(parseFix('{"name":"","arguments":{}}', ['read_file']), null);
});
