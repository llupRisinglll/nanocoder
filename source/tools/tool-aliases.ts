/**
 * Tool naming-convention registry.
 *
 * Different model families are trained on different tool-naming conventions:
 *
 *   - **Claude Code style** (PascalCase): `Bash`, `Read`, `Write`, `Edit`,
 *     `Glob`, `Grep`, `Task`, `WebFetch`, `WebSearch`, `AskUserQuestion`,
 *     `TodoWrite`, `Skill`. Anthropic/Claude models recognize these instantly.
 *   - **Codex/OpenAI style** (snake_case): `apply_patch`, `shell`,
 *     `update_plan`, `spawn_agent`. OpenAI/GPT models trained on Codex
 *     recognize these.
 *   - **nanocoder style** (snake_case, different names): `execute_bash`,
 *     `read_file`, `string_replace`. Used for local/open-weights models
 *     (Ollama, llama.cpp, etc.) and as the internal canonical name for
 *     handlers/formatters/validators.
 *
 * This module is the single source of truth for the mapping. It lets us:
 *
 *   1. Send the model the names it already knows (per-provider adaptive),
 *      so it doesn't have to re-learn tool identities from descriptions.
 *   2. Accept ANY known alias on the way back and resolve to the canonical
 *      handler, so prompts/scripts written against Claude Code or Codex
 *      names keep working.
 *   3. Identify capability gaps (tools Claude Code has that we don't) by
 *      comparing the canonical map against our registry.
 *
 * Sources:
 *   - Claude Code official: https://code.claude.com/docs/en/tools-reference
 *   - openclaude: TOOL_NAME constants under src/tools/ (Claude Code fork)
 *   - codex: tool name strings in codex-rs/core/src/tools/handlers/ spec files
 */

import type {ProviderKind} from '@/types/index';

/**
 * The three model-facing naming conventions. Each provider kind maps to one.
 * `local` covers Ollama/llama.cpp/open-weights models that have no strong
 * convention — we use nanocoder's snake_case names, which are at least
 * self-describing.
 */
export type ToolNameFormat = 'claude-code' | 'codex' | 'local';

/**
 * The canonical (internal) tool name. This is what handlers, formatters,
 * validators, and the tool registry use internally. It never changes.
 */
export type CanonicalToolName = string;

/**
 * A tool's naming record across all three conventions. `canonical` is the
 * internal name; the other fields are what the model sees per format.
 */
export interface ToolNameRecord {
	/** Internal name used by handlers/registry. Never sent to the model. */
	canonical: CanonicalToolName;
	/** Claude Code PascalCase name (Anthropic/Claude models). */
	claudeCode?: string;
	/** Codex/OpenAI snake_case name (GPT models trained on Codex). */
	codex?: string;
	/**
	 * Local/open-weights name. Falls back to `canonical` when not set.
	 * Used for Ollama/llama.cpp/etc. where there's no strong convention.
	 */
	local?: string;
}

/**
 * The canonical tool-name registry. One row per capability.
 *
 * Tools not listed here (MCP tools, custom tools, skill-provided tools) have
 * no aliases — they're sent under their registered name in all formats.
 *
 * `claudeCode` values are verified against openclaude's `*_TOOL_NAME`
 * constants and the official Claude Code tools-reference page.
 * `codex` values are verified against codex-rs `*_spec.rs` files.
 */
const REGISTRY: ToolNameRecord[] = [
	// --- Shell ---
	{
		canonical: 'execute_bash',
		claudeCode: 'Bash',
		codex: 'shell',
		local: 'execute_bash',
	},

	// --- File reading ---
	{
		canonical: 'read_file',
		claudeCode: 'Read',
		local: 'read_file',
	},

	// --- File writing ---
	{
		canonical: 'write_file',
		claudeCode: 'Write',
		local: 'write_file',
	},

	// --- File editing (string replacement) ---
	{
		canonical: 'string_replace',
		claudeCode: 'Edit',
		local: 'string_replace',
	},

	// --- File editing (unified diff) ---
	{
		canonical: 'diff_edit',
		claudeCode: 'Edit',
		codex: 'apply_patch',
		local: 'diff_edit',
	},

	// --- File operations (delete/move/copy/mkdir) ---
	{
		canonical: 'file_op',
		local: 'file_op',
	},

	// --- File discovery (glob) ---
	{
		canonical: 'find_files',
		claudeCode: 'Glob',
		local: 'find_files',
	},

	// --- Content search (grep) ---
	{
		canonical: 'search_file_contents',
		claudeCode: 'Grep',
		local: 'search_file_contents',
	},

	// --- Directory listing ---
	{
		canonical: 'list_directory',
		claudeCode: 'LS',
		local: 'list_directory',
	},

	// --- Web search ---
	{
		canonical: 'web_search',
		claudeCode: 'WebSearch',
		local: 'web_search',
	},

	// --- URL fetch ---
	{
		canonical: 'fetch_url',
		claudeCode: 'WebFetch',
		local: 'fetch_url',
	},

	// --- Subagent / task delegation ---
	{
		canonical: 'agent',
		claudeCode: 'Task',
		codex: 'spawn_agent',
		local: 'agent',
	},

	// --- Ask the user a question ---
	{
		canonical: 'ask_user',
		claudeCode: 'AskUserQuestion',
		local: 'ask_user',
	},

	// --- Task / todo list management ---
	{
		canonical: 'write_tasks',
		claudeCode: 'TodoWrite',
		codex: 'update_plan',
		local: 'write_tasks',
	},

	// --- LSP diagnostics ---
	{
		canonical: 'lsp_get_diagnostics',
		claudeCode: 'LSP',
		local: 'lsp_get_diagnostics',
	},

	// --- Skill loader ---
	{
		canonical: 'skill',
		claudeCode: 'Skill',
		local: 'skill',
	},

	// --- Git operations (Claude Code uses Bash for git; we have dedicated tools) ---
	{canonical: 'git_status', local: 'git_status'},
	{canonical: 'git_diff', local: 'git_diff'},
	{canonical: 'git_log', local: 'git_log'},
	{canonical: 'git_add', local: 'git_add'},
	{canonical: 'git_commit', local: 'git_commit'},
	{canonical: 'git_push', local: 'git_push'},
	{canonical: 'git_pull', local: 'git_pull'},
	{canonical: 'git_branch', local: 'git_branch'},
	{canonical: 'git_stash', local: 'git_stash'},
	{canonical: 'git_reset', local: 'git_reset'},
	{canonical: 'git_pr', local: 'git_pr'},

	// --- Skill authoring linter (fork-specific, no aliases) ---
	{canonical: 'check_skill', local: 'check_skill'},
];

// =============================================================================
// Lookup indices (built once at module load)
// =============================================================================

const byCanonical = new Map<string, ToolNameRecord>();
const byAlias = new Map<string, CanonicalToolName>(); // alias → canonical

for (const record of REGISTRY) {
	byCanonical.set(record.canonical, record);
	// Every name form (canonical + all aliases) maps back to canonical.
	// Case-sensitive on purpose: providers send exact case, and we want
	// `Bash` and `bash` to both resolve (the repair hook normalizes case).
	registerAlias(record.canonical, record.canonical);
	if (record.claudeCode) registerAlias(record.claudeCode, record.canonical);
	if (record.codex) registerAlias(record.codex, record.canonical);
	if (record.local) registerAlias(record.local, record.canonical);
	// Also register lowercase forms so case-insensitive lookups work without
	// an extra normalization pass in the hot path.
	registerAlias(record.canonical.toLowerCase(), record.canonical);
	if (record.claudeCode)
		registerAlias(record.claudeCode.toLowerCase(), record.canonical);
	if (record.codex) registerAlias(record.codex.toLowerCase(), record.canonical);
	if (record.local)
		registerAlias(record.local?.toLowerCase() ?? '', record.canonical);
}

function registerAlias(alias: string, canonical: CanonicalToolName): void {
	if (!alias) return;
	// First registration wins — if two tools claim the same alias, the
	// canonical one takes precedence. This shouldn't happen in the static
	// registry but guards against future mistakes.
	if (!byAlias.has(alias)) {
		byAlias.set(alias, canonical);
	}
}

// =============================================================================
// Format selection
// =============================================================================

/**
 * Map a provider kind to its preferred naming convention. This is the
 * per-provider adaptive decision: Anthropic gets Claude Code names, OpenAI/
 * Codex gets Codex names, everything else gets nanocoder snake_case.
 */
export function formatForProvider(
	kind: ProviderKind | undefined,
): ToolNameFormat {
	switch (kind) {
		case 'anthropic':
			return 'claude-code';
		case 'chatgpt-codex':
		case 'github-copilot':
			return 'codex';
		case 'openai-compatible':
		case 'google':
		case undefined:
			return 'local';
	}
}

/**
 * Resolve a canonical tool name to the model-facing name for a given format.
 * Tools without an alias for the format fall back to the canonical name.
 *
 * Example: `displayForFormat('execute_bash', 'claude-code')` → `'Bash'`
 */
export function displayForFormat(
	canonical: CanonicalToolName,
	format: ToolNameFormat,
): string {
	const record = byCanonical.get(canonical);
	if (!record) return canonical;
	switch (format) {
		case 'claude-code':
			return record.claudeCode ?? record.local ?? record.canonical;
		case 'codex':
			return record.codex ?? record.local ?? record.canonical;
		case 'local':
			return record.local ?? record.canonical;
	}
}

/**
 * Resolve an incoming tool-call name (which may be any known alias) back to
 * the canonical internal name. Case-insensitive.
 *
 * Example: `resolveToCanonical('Bash')` → `'execute_bash'`
 * Example: `resolveToCanonical('apply_patch')` → `'diff_edit'`
 *
 * Returns the input unchanged if no alias is known (MCP/custom/skill tools).
 */
export function resolveToCanonical(name: string): CanonicalToolName {
	// Try exact match first (fast path), then case-insensitive.
	return byAlias.get(name) ?? byAlias.get(name.toLowerCase()) ?? name;
}

/**
 * Remap a tools record's keys from canonical names to the model-facing names
 * for a given format. Returns a new record; the tool definitions themselves
 * are preserved (only the keys change).
 *
 * Tools without a known alias pass through under their canonical name.
 */
export function remapToolKeys(
	tools: Record<string, unknown>,
	format: ToolNameFormat,
): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [canonical, tool] of Object.entries(tools)) {
		const display = displayForFormat(canonical, format);
		result[display] = tool;
	}
	return result;
}

// =============================================================================
// Registry introspection (for gap analysis and tooling)
// =============================================================================

/**
 * Return the full registry, primarily for gap-analysis tooling and `/tools`
 * display. Each record shows all known names for a capability.
 */
export function getToolNameRegistry(): readonly ToolNameRecord[] {
	return REGISTRY;
}

/**
 * Given a list of canonical tool names a provider supports, return the
 * Claude Code capabilities that are NOT covered. Useful for gap analysis:
 * "we're missing NotebookEdit, etc."
 */
export function missingClaudeCodeCapabilities(
	availableCanonical: string[],
): string[] {
	const have = new Set(availableCanonical);
	const gaps: string[] = [];
	for (const record of REGISTRY) {
		if (record.claudeCode && !have.has(record.canonical)) {
			gaps.push(record.claudeCode);
		}
	}
	// Tools Claude Code has that aren't in our registry at all.
	const knownClaudeCodeExtras = [
		'NotebookEdit',
		'ExitPlanMode',
		'EnterPlanMode',
	];
	for (const extra of knownClaudeCodeExtras) {
		if (!have.has(resolveToCanonical(extra))) {
			gaps.push(extra);
		}
	}
	return gaps;
}
