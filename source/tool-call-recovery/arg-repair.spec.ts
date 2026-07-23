import test from 'ava';
import {repairToolArguments} from './arg-repair';
import type {JSONSchemaLike} from './types';

console.log(`\ntool-call-recovery/arg-repair.spec.ts`);

test('json: jsonrepair fixes broken JSON (single quotes, trailing comma)', t => {
	const result = repairToolArguments(
		"{'path': '/a.txt', 'count': 3,}",
		'json',
	);
	t.deepEqual(result?.args, {path: '/a.txt', count: 3});
	t.deepEqual(result?.notes, []);
});

test('json: unquoted keys + Python literals repaired', t => {
	const result = repairToolArguments(
		'{command: "ls", quiet: True, extra: None}',
		'function-tag',
	);
	t.deepEqual(result?.args, {command: 'ls', quiet: true, extra: null});
});

test('json: unsalvageable / non-object returns null', t => {
	t.is(repairToolArguments('[1, 2, 3]', 'json'), null);
	t.is(repairToolArguments('"just a string"', 'json'), null);
});

test('xml-tags: extracts every parameter pair (trimmed strings)', t => {
	const raw = `<parameter name="command">  lsof -i :4000  </parameter>
<parameter name="quiet">true</parameter>`;
	const result = repairToolArguments(raw, 'xml-tags');
	t.deepEqual(result?.args, {command: 'lsof -i :4000', quiet: 'true'});
});

test('xml-tags: tolerates missing </parameter> and trailing </function>', t => {
	// The command param has NO closing tag — value must run up to </function>.
	const raw = `<parameter name='command'>grep LISTEN</function>`;
	const result = repairToolArguments(raw, 'attribute-merged');
	t.deepEqual(result?.args, {command: 'grep LISTEN'});
});

test('xml-tags: no parameters found returns null', t => {
	t.is(repairToolArguments('some random text', 'xml-tags'), null);
});

test('coerce: string → array via CSV split', t => {
	const schema: JSONSchemaLike = {
		type: 'object',
		properties: {files: {type: 'array'}},
	};
	const result = repairToolArguments(
		'<parameter name="files">a.ts, b.ts ,c.ts</parameter>',
		'xml-tags',
		schema,
	);
	t.deepEqual(result?.args, {files: ['a.ts', 'b.ts', 'c.ts']});
	t.true(result?.notes.some(n => n.includes('array')));
});

test('coerce: string → array via JSON list', t => {
	const schema: JSONSchemaLike = {
		type: 'object',
		properties: {files: {type: 'array'}},
	};
	const result = repairToolArguments(
		'{"files": "[\\"a\\", \\"b\\"]"}',
		'json',
		schema,
	);
	t.deepEqual(result?.args, {files: ['a', 'b']});
});

test('coerce: drop null / {} optional keys, keep required', t => {
	const schema: JSONSchemaLike = {
		type: 'object',
		properties: {
			path: {type: 'string'},
			opts: {type: 'object'},
			extra: {type: 'string'},
		},
		required: ['path'],
	};
	const result = repairToolArguments(
		'{"path": "/a", "extra": null, "opts": {}}',
		'json',
		schema,
	);
	t.deepEqual(result?.args, {path: '/a'});
	t.is(result?.notes.filter(n => n.includes('dropped')).length, 2);
});

test('coerce: does NOT drop a null value that is required', t => {
	const schema: JSONSchemaLike = {
		type: 'object',
		properties: {path: {type: 'string'}},
		required: ['path'],
	};
	const result = repairToolArguments('{"path": null}', 'json', schema);
	t.deepEqual(result?.args, {path: null});
});

test('coerce: boolean and number string coercions', t => {
	const schema: JSONSchemaLike = {
		type: 'object',
		properties: {quiet: {type: 'boolean'}, count: {type: 'number'}},
	};
	const result = repairToolArguments(
		'<parameter name="quiet">false</parameter><parameter name="count">42</parameter>',
		'xml-tags',
		schema,
	);
	t.deepEqual(result?.args, {quiet: false, count: 42});
});

test('coerce: unwrap double-JSON-encoded string', t => {
	const schema: JSONSchemaLike = {
		type: 'object',
		properties: {message: {type: 'string'}},
	};
	// message value is the JSON string "\"hi\"" — a string wrapping a string.
	const result = repairToolArguments(
		'{"message": "\\"hi\\""}',
		'json',
		schema,
	);
	t.deepEqual(result?.args, {message: 'hi'});
	t.true(result?.notes.some(n => n.includes('unwrapped')));
});

test('coerce: disabled when coerceArgs is false', t => {
	const schema: JSONSchemaLike = {
		type: 'object',
		properties: {files: {type: 'array'}},
	};
	const result = repairToolArguments(
		'<parameter name="files">a,b</parameter>',
		'xml-tags',
		schema,
		{coerceArgs: false},
	);
	t.deepEqual(result?.args, {files: 'a,b'});
	t.deepEqual(result?.notes, []);
});
