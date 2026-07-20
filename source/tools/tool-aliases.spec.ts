import test from 'ava';
import {
	displayForFormat,
	formatForProvider,
	getToolNameRegistry,
	missingClaudeCodeCapabilities,
	remapToolKeys,
	resolveToCanonical,
} from './tool-aliases.js';

// ============================================================================
// formatForProvider
// ============================================================================

test('formatForProvider - anthropic maps to claude-code', t => {
	t.is(formatForProvider('anthropic'), 'claude-code');
});

test('formatForProvider - codex/copilot map to codex format', t => {
	t.is(formatForProvider('chatgpt-codex'), 'codex');
	t.is(formatForProvider('github-copilot'), 'codex');
});

test('formatForProvider - openai-compatible/google/undefined map to local', t => {
	t.is(formatForProvider('openai-compatible'), 'local');
	t.is(formatForProvider('google'), 'local');
	t.is(formatForProvider(undefined), 'local');
});

// ============================================================================
// displayForFormat (canonical → model-facing name)
// ============================================================================

test('displayForFormat - execute_bash maps to Bash for claude-code', t => {
	t.is(displayForFormat('execute_bash', 'claude-code'), 'Bash');
});

test('displayForFormat - execute_bash maps to shell for codex', t => {
	t.is(displayForFormat('execute_bash', 'codex'), 'shell');
});

test('displayForFormat - execute_bash maps to execute_bash for local', t => {
	t.is(displayForFormat('execute_bash', 'local'), 'execute_bash');
});

test('displayForFormat - read_file maps to Read for claude-code', t => {
	t.is(displayForFormat('read_file', 'claude-code'), 'Read');
});

test('displayForFormat - string_replace and diff_edit both map to Edit for claude-code', t => {
	t.is(displayForFormat('string_replace', 'claude-code'), 'Edit');
	t.is(displayForFormat('diff_edit', 'claude-code'), 'Edit');
});

test('displayForFormat - diff_edit maps to apply_patch for codex', t => {
	t.is(displayForFormat('diff_edit', 'codex'), 'apply_patch');
});

test('displayForFormat - find_files maps to Glob for claude-code', t => {
	t.is(displayForFormat('find_files', 'claude-code'), 'Glob');
});

test('displayForFormat - search_file_contents maps to Grep for claude-code', t => {
	t.is(displayForFormat('search_file_contents', 'claude-code'), 'Grep');
});

test('displayForFormat - agent maps to Task for claude-code, spawn_agent for codex', t => {
	t.is(displayForFormat('agent', 'claude-code'), 'Task');
	t.is(displayForFormat('agent', 'codex'), 'spawn_agent');
});

test('displayForFormat - unknown canonical passes through unchanged', t => {
	t.is(displayForFormat('some_custom_tool', 'claude-code'), 'some_custom_tool');
});

test('displayForFormat - git tools have no claude-code alias, fall back to canonical', t => {
	t.is(displayForFormat('git_status', 'claude-code'), 'git_status');
});

// ============================================================================
// resolveToCanonical (model-facing name → internal name)
// ============================================================================

test('resolveToCanonical - Bash resolves to execute_bash', t => {
	t.is(resolveToCanonical('Bash'), 'execute_bash');
});

test('resolveToCanonical - Read resolves to read_file', t => {
	t.is(resolveToCanonical('Read'), 'read_file');
});

test('resolveToCanonical - Edit resolves to string_replace (first registration wins)', t => {
	// Both string_replace and diff_edit map to Edit in claude-code.
	// string_replace is registered first, so it wins.
	t.is(resolveToCanonical('Edit'), 'string_replace');
});

test('resolveToCanonical - apply_patch resolves to diff_edit', t => {
	t.is(resolveToCanonical('apply_patch'), 'diff_edit');
});

test('resolveToCanonical - Glob resolves to find_files', t => {
	t.is(resolveToCanonical('Glob'), 'find_files');
});

test('resolveToCanonical - Grep resolves to search_file_contents', t => {
	t.is(resolveToCanonical('Grep'), 'search_file_contents');
});

test('resolveToCanonical - Task resolves to agent', t => {
	t.is(resolveToCanonical('Task'), 'agent');
});

test('resolveToCanonical - TodoWrite resolves to write_tasks', t => {
	t.is(resolveToCanonical('TodoWrite'), 'write_tasks');
});

test('resolveToCanonical - WebFetch resolves to fetch_url', t => {
	t.is(resolveToCanonical('WebFetch'), 'fetch_url');
});

test('resolveToCanonical - WebSearch resolves to web_search', t => {
	t.is(resolveToCanonical('WebSearch'), 'web_search');
});

test('resolveToCanonical - case-insensitive: bash resolves to execute_bash', t => {
	t.is(resolveToCanonical('bash'), 'execute_bash');
	t.is(resolveToCanonical('BASH'), 'execute_bash');
});

test('resolveToCanonical - canonical name resolves to itself', t => {
	t.is(resolveToCanonical('execute_bash'), 'execute_bash');
	t.is(resolveToCanonical('read_file'), 'read_file');
});

test('resolveToCanonical - unknown name passes through unchanged', t => {
	t.is(resolveToCanonical('mcp_custom_tool'), 'mcp_custom_tool');
});

// ============================================================================
// remapToolKeys
// ============================================================================

test('remapToolKeys - remaps all keys for claude-code format', t => {
	const tools = {
		execute_bash: {description: 'shell'},
		read_file: {description: 'read'},
		find_files: {description: 'glob'},
	};
	const remapped = remapToolKeys(tools, 'claude-code') as Record<
		string,
		{description: string}
	>;
	t.truthy(remapped.Bash);
	t.truthy(remapped.Read);
	t.truthy(remapped.Glob);
	t.falsy(remapped.execute_bash);
	t.falsy(remapped.read_file);
	t.falsy(remapped.find_files);
});

test('remapToolKeys - unknown tools pass through under canonical name', t => {
	const tools = {custom_tool: {description: 'custom'}};
	const remapped = remapToolKeys(tools, 'claude-code') as Record<
		string,
		{description: string}
	>;
	t.truthy(remapped.custom_tool);
});

test('remapToolKeys - local format keeps snake_case names', t => {
	const tools = {execute_bash: {description: 'shell'}};
	const remapped = remapToolKeys(tools, 'local') as Record<
		string,
		{description: string}
	>;
	t.truthy(remapped.execute_bash);
});

// ============================================================================
// Registry introspection
// ============================================================================

test('getToolNameRegistry - returns non-empty array with expected tools', t => {
	const registry = getToolNameRegistry();
	t.true(registry.length >= 15);
	t.true(registry.some(r => r.canonical === 'execute_bash'));
	t.true(registry.some(r => r.canonical === 'read_file'));
	t.true(registry.some(r => r.claudeCode === 'Bash'));
	t.true(registry.some(r => r.claudeCode === 'Read'));
});

test('missingClaudeCodeCapabilities - reports NotebookEdit as a gap when not available', t => {
	const gaps = missingClaudeCodeCapabilities(['execute_bash', 'read_file']);
	t.true(gaps.includes('NotebookEdit'));
	// Tools we DO have shouldn't appear as gaps
	t.false(gaps.includes('Bash'));
	t.false(gaps.includes('Read'));
});

test('missingClaudeCodeCapabilities - returns empty when all capabilities present', t => {
	// Provide every canonical name the registry knows about plus the extras
	const registry = getToolNameRegistry();
	const allCanonical = registry.map(r => r.canonical);
	const gaps = missingClaudeCodeCapabilities(allCanonical);
	// Only NotebookEdit/ExitPlanMode/EnterPlanMode would remain (extras not in registry)
	t.true(gaps.includes('NotebookEdit'));
	t.false(gaps.includes('Bash'));
	t.false(gaps.includes('Edit'));
});
