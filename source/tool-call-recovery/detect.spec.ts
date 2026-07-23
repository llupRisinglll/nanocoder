console.log('\ntool-call-recovery/detect.spec.ts');

import test from 'ava';
import {detectLeakedToolCalls} from './detect';

test('attribute-merged: the exact README/types example', t => {
	const text = `<tool_call>
<function=execute_bparameter name="command">lsof -i :4000 -i :4001 2>/dev/null | grep LISTEN</parameter>
</function>
</tool_call>`;
	const found = detectLeakedToolCalls(text);
	t.is(found.length, 1);
	const c = found[0];
	t.is(c.format, 'attribute-merged');
	// The fused artifact stays ON the name for the fuzzy-matcher to strip.
	t.is(c.rawName, 'execute_bparameter');
	t.true(c.rawArgs.startsWith('name="command">'));
	t.true(c.rawArgs.includes('lsof -i :4000'));
	t.true(c.rawArgs.endsWith('</parameter>'));
	// Span covers the whole <tool_call> block, and its text round-trips.
	t.is(c.span.text, text.slice(c.span.start, c.span.end));
	t.true(c.span.text.startsWith('<tool_call>'));
	t.true(c.span.text.endsWith('</tool_call>'));
});

test('attribute-merged with param (short) artifact and no wrapper', t => {
	const text = `<function=read_fileparam name="path">/etc/hosts</parameter>`;
	const found = detectLeakedToolCalls(text);
	t.is(found.length, 1);
	t.is(found[0].format, 'attribute-merged');
	t.is(found[0].rawName, 'read_fileparam');
	t.true(found[0].rawArgs.startsWith('name="path">'));
});

test('xml-tags: full well-formed tool_call', t => {
	const text = `<tool_call><function=list_dir><parameter name="path">/tmp</parameter><parameter name="depth">2</parameter></function></tool_call>`;
	const found = detectLeakedToolCalls(text);
	t.is(found.length, 1);
	t.is(found[0].format, 'xml-tags');
	t.is(found[0].rawName, 'list_dir');
	t.true(found[0].rawArgs.includes('<parameter name="path">/tmp</parameter>'));
	t.true(found[0].rawArgs.includes('<parameter name="depth">2</parameter>'));
});

test('xml-tags: missing </function> and </tool_call> close tags', t => {
	const text = `<function=grep><parameter name="pattern">TODO</parameter>`;
	const found = detectLeakedToolCalls(text);
	t.is(found.length, 1);
	t.is(found[0].rawName, 'grep');
	t.is(found[0].format, 'xml-tags');
	t.true(found[0].rawArgs.includes('TODO'));
});

test('function-tag: Llama-style <function=name>{json}</function>', t => {
	const text = `<function=search>{"query": "ink hooks", "limit": 5}</function>`;
	const found = detectLeakedToolCalls(text);
	t.is(found.length, 1);
	t.is(found[0].format, 'function-tag');
	t.is(found[0].rawName, 'search');
	t.is(found[0].rawArgs, '{"query": "ink hooks", "limit": 5}');
});

test('a real tool name that ends in "param" followed by > is NOT fused', t => {
	const text = `<function=set_param>{"value": 1}</function>`;
	const found = detectLeakedToolCalls(text);
	t.is(found.length, 1);
	t.is(found[0].rawName, 'set_param');
	t.is(found[0].format, 'function-tag');
});

test('json: {"tool":…, "arguments":…} shape', t => {
	const text = `Sure, running it now: {"tool": "execute_bash", "arguments": {"command": "ls -la"}}`;
	const found = detectLeakedToolCalls(text);
	t.is(found.length, 1);
	t.is(found[0].format, 'json');
	t.is(found[0].rawName, 'execute_bash');
	t.is(found[0].rawArgs, '{"command": "ls -la"}');
});

test('json: {"name":…, "parameters":…} shape with nested braces', t => {
	const text = `{"name": "write_file", "parameters": {"path": "a.txt", "meta": {"nested": true}}}`;
	const found = detectLeakedToolCalls(text);
	t.is(found.length, 1);
	t.is(found[0].rawName, 'write_file');
	t.is(found[0].rawArgs, '{"path": "a.txt", "meta": {"nested": true}}');
});

test('json: ordinary prose JSON is IGNORED (no tool/args signature)', t => {
	const text = `Here is the config: {"host": "localhost", "port": 4000, "debug": true}`;
	const found = detectLeakedToolCalls(text);
	t.is(found.length, 0);
});

test('fenced ```tool_call block', t => {
	const text = 'Let me do that:\n```tool_call\n{"name": "read_file", "arguments": {"path": "x"}}\n```\nDone.';
	const found = detectLeakedToolCalls(text);
	t.is(found.length, 1);
	t.is(found[0].format, 'json');
	t.is(found[0].rawName, 'read_file');
	t.is(found[0].rawArgs, '{"path": "x"}');
	t.true(found[0].span.text.startsWith('```tool_call'));
});

test('multi-candidate text: three different formats in one blob', t => {
	const text = [
		'First: <function=execute_bparameter name="command">whoami</parameter></function>',
		'Then some prose. {"tool": "read_file", "arguments": {"path": "/a"}}',
		'Finally <function=grep>{"pattern": "x"}</function> ok.',
	].join('\n');
	const found = detectLeakedToolCalls(text);
	t.is(found.length, 3);
	// Returned in source order.
	t.deepEqual(
		found.map(c => c.rawName),
		['execute_bparameter', 'read_file', 'grep'],
	);
	t.deepEqual(
		found.map(c => c.format),
		['attribute-merged', 'json', 'function-tag'],
	);
	// Spans must not overlap.
	for (let i = 1; i < found.length; i++) {
		t.true(found[i].span.start >= found[i - 1].span.end);
	}
});

test('adjacent function calls do not merge into one candidate', t => {
	const text = `<function=a>{"x":1}</function><function=b>{"y":2}</function>`;
	const found = detectLeakedToolCalls(text);
	t.is(found.length, 2);
	t.deepEqual(found.map(c => c.rawName), ['a', 'b']);
	t.is(found[0].rawArgs, '{"x":1}');
	t.is(found[1].rawArgs, '{"y":2}');
});

test('the JSON inside a function-tag is not double-reported', t => {
	const text = `<function=search>{"tool": "x", "arguments": {"q": 1}}</function>`;
	const found = detectLeakedToolCalls(text);
	// Only the function candidate — the embedded JSON is already claimed.
	t.is(found.length, 1);
	t.is(found[0].rawName, 'search');
	t.is(found[0].format, 'function-tag');
});

test('plain prose with no tool shape returns empty', t => {
	t.deepEqual(detectLeakedToolCalls('just a normal answer, nothing to see'), []);
	t.deepEqual(detectLeakedToolCalls(''), []);
});
