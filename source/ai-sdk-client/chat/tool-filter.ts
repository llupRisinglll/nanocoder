import type {AISDKCoreTool, Message} from '@/types/index';

const TOOL_FILTER_THRESHOLD = 24;
const ALWAYS_ACTIVE_TOOLS = new Set([
	'read_file',
	'write_file',
	'string_replace',
	'diff_edit',
	'file_op',
	'execute_bash',
	'find_files',
	'search_file_contents',
	'list_directory',
	'agent',
	'ask_user',
	'write_tasks',
	'skill',
]);

function recentlyUsedToolNames(messages: Message[], limit = 12): Set<string> {
	const names = new Set<string>();
	for (const msg of messages.slice(-limit)) {
		if (msg.role === 'assistant') {
			for (const call of msg.tool_calls ?? []) {
				names.add(call.function.name);
			}
		}
		if (msg.role === 'tool' && msg.name) names.add(msg.name);
	}
	return names;
}

function mentionedToolNames(
	messages: Message[],
	toolNames: string[],
): Set<string> {
	const recentText = messages
		.slice(-4)
		.filter(m => m.role === 'user')
		.map(m => m.content.toLowerCase())
		.join('\n');
	const result = new Set<string>();
	if (!recentText) return result;
	for (const name of toolNames) {
		const readable = name.replace(/_/g, ' ');
		if (
			recentText.includes(name.toLowerCase()) ||
			recentText.includes(readable)
		) {
			result.add(name);
		}
	}
	return result;
}

/**
 * Conservative per-turn tool filtering. Default/built-in tool sets are left
 * intact. Filtering only activates for large tool sets (typically many MCP
 * tools), and always keeps core editing/search tools plus recently-used or
 * explicitly-mentioned tools. This reduces schema bloat without hiding the
 * baseline coding harness.
 */
export function filterActiveToolsForTurn(
	tools: Record<string, AISDKCoreTool>,
	messages: Message[],
): Record<string, AISDKCoreTool> {
	const names = Object.keys(tools);
	if (names.length <= TOOL_FILTER_THRESHOLD) return tools;

	const keep = new Set<string>();
	for (const name of names) {
		if (ALWAYS_ACTIVE_TOOLS.has(name)) keep.add(name);
	}
	for (const name of recentlyUsedToolNames(messages)) keep.add(name);
	for (const name of mentionedToolNames(messages, names)) keep.add(name);

	// Avoid over-filtering: if the retained set is still tiny compared to the
	// original, include all non-MCP-looking tools (built-ins/custom basics) and
	// leave only the broad MCP tail filtered.
	if (keep.size < Math.min(16, names.length)) {
		for (const name of names) {
			if (!name.includes('__') && !name.includes(':')) keep.add(name);
		}
	}

	const filtered: Record<string, AISDKCoreTool> = {};
	for (const name of names) {
		if (keep.has(name)) filtered[name] = tools[name];
	}
	return Object.keys(filtered).length > 0 ? filtered : tools;
}
