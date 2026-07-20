import test from 'ava';
import {
	ALWAYS_EXPANDED_TOOLS,
	LIVE_TASK_TOOLS,
	getGroupedCompactDescription,
} from './tool-result-display.js';

test('ALWAYS_EXPANDED_TOOLS contains the task tool', (t) => {
	t.true(ALWAYS_EXPANDED_TOOLS.has('write_tasks'));
});

test('ALWAYS_EXPANDED_TOOLS does not contain regular tools', (t) => {
	t.false(ALWAYS_EXPANDED_TOOLS.has('read_file'));
	t.false(ALWAYS_EXPANDED_TOOLS.has('write_file'));
	t.false(ALWAYS_EXPANDED_TOOLS.has('execute_bash'));
	t.false(ALWAYS_EXPANDED_TOOLS.has('string_replace'));
});

test('LIVE_TASK_TOOLS contains the task tool', (t) => {
	t.true(LIVE_TASK_TOOLS.has('write_tasks'));
});

test('LIVE_TASK_TOOLS does not contain regular tools', (t) => {
	t.false(LIVE_TASK_TOOLS.has('read_file'));
	t.false(LIVE_TASK_TOOLS.has('execute_bash'));
});

test('getGroupedCompactDescription uses tool-name-first wording', t => {
	t.is(getGroupedCompactDescription('execute_bash', 1), 'execute_bash');
	t.is(getGroupedCompactDescription('execute_bash', 5), 'execute_bash ×5');
	t.is(getGroupedCompactDescription('read_file', 2), 'read_file ×2');
});
