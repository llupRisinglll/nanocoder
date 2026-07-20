import {existsSync, readFileSync} from 'fs';
import {homedir, platform, release} from 'os';
import {basename, dirname, isAbsolute, join, normalize, resolve} from 'path';
import {fileURLToPath} from 'url';
import {isNanoProfile, isSingleToolProfile} from '@/tools/tool-profiles';
import type {SystemPromptConfig, TuneConfig} from '@/types/config';
import {TUNE_DEFAULTS} from '@/types/config';
import type {DevelopmentMode} from '@/types/core';
import {getLogger} from '@/utils/logging';
import {getSubagentDescriptions} from '@/utils/prompt-processor';

/**
 * A built system-prompt block tagged with its cache scope.
 *
 * `stable` blocks are identical for the whole session (identity, principles,
 * tool rules, per-tool guidance). `volatile` blocks change per turn or per
 * cwd (system info, AGENTS.md, user override content).
 *
 * The chat handler uses this split to place the Anthropic cache breakpoint on
 * the last stable block only, so per-turn changes (cwd, date) don't bust the
 * cached stable prefix.
 */
export interface BuiltPromptBlock {
	text: string;
	cacheScope: 'stable' | 'volatile';
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const sectionsDir = join(__dirname, '../../source/app/prompts/sections');

// Cache loaded sections to avoid re-reading files
const sectionCache = new Map<string, string>();

function getSectionFilePath(name: string): string {
	const normalizedName = normalize(name).replace(/^([/\\])+/, '');
	const safeName = basename(normalizedName);
	return join(sectionsDir, `${safeName}.md`);
}

function loadSection(name: string): string {
	const cached = sectionCache.get(name);
	if (cached !== undefined) return cached;

	const filePath = getSectionFilePath(name);
	try {
		const content = readFileSync(filePath, 'utf-8').trim();
		sectionCache.set(name, content);
		return content;
	} catch (error) {
		const logger = getLogger();
		logger.warn(`Failed to load prompt section "${name}": ${String(error)}`);
		sectionCache.set(name, '');
		return '';
	}
}

/** Reset section cache for testing. */
export function resetSectionCache(): void {
	sectionCache.clear();
}

// Cache the last-built system prompt so token-counting callers
// (e.g. /status, /usage, /compact) can access it without needing
// developmentMode/tune/tools as arguments.
let lastBuiltPrompt: string | null = null;

/**
 * Get the last system prompt produced by buildSystemPrompt().
 * Falls back to a minimal prompt if buildSystemPrompt hasn't been called yet.
 */
export function getLastBuiltPrompt(): string {
	return (
		lastBuiltPrompt ?? 'You are Nanocoder, a terminal-based AI coding agent.'
	);
}

/**
 * Update the cached prompt after post-processing (e.g. XML tool injection).
 * Ensures token-counting callers see the full prompt the model receives.
 */
export function setLastBuiltPrompt(prompt: string): void {
	lastBuiltPrompt = prompt;
}

function generateSystemInfo(slim = false): string {
	const now = new Date();
	const dateStr = now.toISOString().split('T')[0];

	const getDefaultShell = (): string => {
		if (process.env.SHELL) return process.env.SHELL;
		if (platform() === 'win32') return process.env.COMSPEC || 'cmd.exe';
		if (platform() === 'darwin') return '/bin/zsh';
		return '/bin/bash';
	};

	const getOSName = (): string => {
		switch (platform()) {
			case 'darwin':
				return 'macOS';
			case 'win32':
				return 'Windows';
			case 'linux':
				return 'Linux';
			default:
				return platform();
		}
	};

	if (slim) {
		return `## SYSTEM
OS: ${getOSName()} | Shell: ${getDefaultShell()} | CWD: ${process.cwd()} | Date: ${dateStr}`;
	}

	return `## SYSTEM INFORMATION

Operating System: ${getOSName()}
OS Version: ${release()}
Platform: ${platform()}
Default Shell: ${getDefaultShell()}
Home Directory: ${homedir()}
Current Working Directory: ${process.cwd()}
Current Date: ${dateStr}`;
}

// Search/discovery tools that justify a "prefer native over bash" instruction
// read_file alone doesn't count — the model needs search tools for the advice to be meaningful
const NATIVE_SEARCH_TOOLS = new Set([
	'find_files',
	'search_file_contents',
	'list_directory',
]);

function hasNativeSearchTools(toolSet: Set<string>): boolean {
	for (const tool of NATIVE_SEARCH_TOOLS) {
		if (toolSet.has(tool)) return true;
	}
	return false;
}

function hasAnyGitTool(toolSet: Set<string>): boolean {
	for (const name of toolSet) {
		if (name.startsWith('git_')) return true;
	}
	return false;
}

function getIdentitySectionName(model?: string): string {
	const id = model?.toLowerCase() ?? '';
	if (id.includes('claude')) return 'identity-anthropic';
	if (id.includes('gemini')) return 'identity-gemini';
	if (
		id.includes('gpt') ||
		id.includes('o1') ||
		id.includes('o3') ||
		id.includes('o4') ||
		id.includes('codex')
	) {
		return 'identity-gpt';
	}
	if (
		id.includes('ollama') ||
		id.includes('llama') ||
		id.includes('qwen') ||
		id.includes('deepseek') ||
		id.includes('glm') ||
		id.includes('kimi') ||
		id.includes('mistral') ||
		id.includes('mixtral')
	) {
		return 'identity-local';
	}
	return 'identity';
}

/**
 * Resolve the override content from a SystemPromptConfig: inline content wins
 * over file. Returns the prompt string, or null if neither is usable.
 */
function resolveSystemPromptOverride(
	override: SystemPromptConfig,
): string | null {
	if (override.content !== undefined) {
		if (override.file !== undefined) {
			getLogger().warn(
				'systemPrompt: both `content` and `file` set — using `content`.',
			);
		}
		return override.content;
	}

	if (override.file !== undefined) {
		// Path comes from the user's own agents.config.json (trusted config), same model as source/config/index.ts
		const filePath = isAbsolute(override.file)
			? override.file
			: resolve(process.cwd(), override.file); // nosemgrep
		try {
			return readFileSync(filePath, 'utf-8');
		} catch (error) {
			getLogger().warn(
				`systemPrompt: failed to read file "${filePath}": ${String(error)}`,
			);
			return null;
		}
	}

	return null;
}

/**
 * Build a system prompt dynamically based on development mode, tune config, and available tools.
 *
 * Sections are full quality — the prompt gets smaller only because sections for
 * unavailable tools are excluded entirely, not because content is truncated.
 *
 * When `systemPromptOverride` is provided, the user's custom prompt either replaces
 * the built-in prompt entirely (mode="replace", the default) or is appended to it
 * (mode="append").
 */
export function buildSystemPrompt(
	developmentMode: DevelopmentMode,
	tuneConfig: TuneConfig | undefined,
	availableToolNames: string[],
	toolsDisabled = false,
	systemPromptOverride?: SystemPromptConfig,
	model?: string,
): string {
	const blocks = buildSystemPromptBlocks(
		developmentMode,
		tuneConfig,
		availableToolNames,
		toolsDisabled,
		systemPromptOverride,
		model,
	);
	const prompt = blocks
		.map(b => b.text)
		.filter(Boolean)
		.join('\n\n');
	lastBuiltPrompt = prompt;
	return prompt;
}

/**
 * Build the system prompt as a list of cache-scoped blocks. Identical content
 * to {@link buildSystemPrompt}; the only difference is the return shape.
 *
 * The block split enables prompt caching: every block up to and excluding the
 * first `volatile` block is stable for the whole session (identity, principles,
 * tool guidance) and can carry an Anthropic `cache_control` breakpoint; the
 * `volatile` blocks (`generateSystemInfo()` output with cwd/date, AGENTS.md
 * content, and any user override) change per turn and must NOT be cached.
 *
 * Callers that just need the joined string (token counting, /usage display)
 * should use {@link buildSystemPrompt} or {@link getLastBuiltPrompt}. Only the
 * chat handler needs this structured form, to place the cache breakpoint.
 */
export function buildSystemPromptBlocks(
	developmentMode: DevelopmentMode,
	tuneConfig: TuneConfig | undefined,
	availableToolNames: string[],
	toolsDisabled = false,
	systemPromptOverride?: SystemPromptConfig,
	model?: string,
): BuiltPromptBlock[] {
	const overrideContent = systemPromptOverride
		? resolveSystemPromptOverride(systemPromptOverride)
		: null;
	const overrideMode = systemPromptOverride?.mode ?? 'replace';

	// Replace-mode override replaces the entire prompt — emit it as a single
	// volatile block (it's user-controlled text we can't assume is stable).
	if (overrideContent !== null && overrideMode === 'replace') {
		return [{text: overrideContent, cacheScope: 'volatile'}];
	}

	const tune = tuneConfig ?? TUNE_DEFAULTS;
	const singleTool =
		tune.enabled && isSingleToolProfile(tune.toolProfile, model);
	const nano = tune.enabled && isNanoProfile(tune.toolProfile, model);
	const toolSet = new Set(availableToolNames);
	const stableSections: string[] = [];

	// Always included. The base identity is lightly tuned by model family
	// (Claude/GPT/Gemini/local) while preserving the same safety boundary.
	stableSections.push(loadSection(getIdentitySectionName(model)));

	// Core principles — dropped under nano (identity + tool rules cover the essentials)
	if (!nano) {
		stableSections.push(loadSection('core-principles'));
	}

	// Mode-specific task approach (nano variant when active)
	stableSections.push(
		loadSection(
			nano
				? `task-approach-nano-${developmentMode}`
				: `task-approach-${developmentMode}`,
		),
	);

	// Tool rules — XML variant when native tool calling is disabled
	let toolRules = loadSection(toolsDisabled ? 'tool-rules-xml' : 'tool-rules');
	if (singleTool) {
		toolRules +=
			'\n- **IMPORTANT**: Call exactly ONE tool per response. Wait for the result before calling the next tool.';
	}
	stableSections.push(toolRules);

	// File operations — only if any file mutation tools are available
	if (
		toolSet.has('string_replace') ||
		toolSet.has('write_file') ||
		toolSet.has('file_op')
	) {
		stableSections.push(
			loadSection(nano ? 'file-editing-nano' : 'file-editing'),
		);
	}

	// Native tool preference — only if bash AND search/discovery tools are both available.
	// Skipped under nano: nano profile has no native search/discovery tools by design.
	if (!nano && toolSet.has('execute_bash') && hasNativeSearchTools(toolSet)) {
		stableSections.push(loadSection('native-tool-preference'));
	}

	// Git tools — only if any git tools are available
	if (hasAnyGitTool(toolSet)) {
		// Plan mode only has read-only git tools — use plan-specific section
		stableSections.push(
			loadSection(
				developmentMode === 'plan' ? 'git-tools-readonly' : 'git-tools',
			),
		);
	}

	// Task management — only if write_tasks is available AND not in plan mode
	if (toolSet.has('write_tasks') && developmentMode !== 'plan') {
		stableSections.push(loadSection('task-management'));
	}

	// Web tools — only if web_search or fetch_url are available
	if (toolSet.has('web_search') || toolSet.has('fetch_url')) {
		stableSections.push(loadSection('web-tools'));
	}

	// Diagnostics — only if lsp_get_diagnostics is available
	if (toolSet.has('lsp_get_diagnostics')) {
		// Plan mode: check for existing issues, not "fix what you introduce"
		stableSections.push(
			loadSection(
				developmentMode === 'plan' ? 'diagnostics-readonly' : 'diagnostics',
			),
		);
	}

	// Asking questions — only if ask_user is available
	if (toolSet.has('ask_user')) {
		// Plan mode gets stronger upfront-questioning guidance
		stableSections.push(
			loadSection(
				developmentMode === 'plan'
					? 'asking-questions-plan'
					: 'asking-questions',
			),
		);
	}

	// Coding practices and constraints — not needed in plan mode
	// (plan task approach already covers the relevant guidance).
	// Under nano, drop coding-practices and use the shortened constraints.
	if (developmentMode !== 'plan') {
		if (!nano) {
			stableSections.push(loadSection('coding-practices'));
		}
		stableSections.push(loadSection(nano ? 'constraints-nano' : 'constraints'));
	}

	// Subagents — only if the agent tool is available
	if (toolSet.has('agent')) {
		const subagentSection = loadSection('subagents');
		const subagentInfo = `${subagentSection}

### Available subagents:

${getSubagentDescriptions()}`;
		stableSections.push(subagentInfo);
	}

	// All sections above are stable (they depend only on dev mode, tune, and
	// the tool set — none of which change mid-session). Join them into one
	// stable block so the cache breakpoint lands on a single, contiguous
	// prefix.
	const blocks: BuiltPromptBlock[] = [];
	const stableText = stableSections.filter(Boolean).join('\n\n');
	if (stableText.length > 0) {
		blocks.push({text: stableText, cacheScope: 'stable'});
	}

	// Volatile: system info (cwd, date change per turn / per directory).
	blocks.push({text: generateSystemInfo(nano), cacheScope: 'volatile'});

	// Volatile: AGENTS.md (file can be edited mid-session). Nano omits it by
	// default; users can override via tune.includeAgentsMd.
	const includeAgentsMd = tune.includeAgentsMd ?? (nano ? false : true);
	if (includeAgentsMd) {
		const agentsBlock = readAgentsMdBlock();
		if (agentsBlock.length > 0) {
			blocks.push({text: agentsBlock, cacheScope: 'volatile'});
		}
	}

	// Volatile: append-mode user override (replace mode handled at the top).
	if (overrideContent !== null && overrideMode === 'append') {
		blocks.push({text: overrideContent, cacheScope: 'volatile'});
	}

	return blocks.filter(b => b.text.length > 0);
}

/**
 * Read AGENTS.md (if present in cwd) and return it wrapped in the same
 * "Additional Context..." framing that the legacy prompt builder used, so the
 * model-visible content is unchanged. Returns '' when the file is absent or
 * unreadable.
 */
function readAgentsMdBlock(): string {
	const agentsPath = join(process.cwd(), 'AGENTS.md');
	if (!existsSync(agentsPath)) return '';
	try {
		const agentsContent = readFileSync(agentsPath, 'utf-8');
		return `Additional Context...\n\n${agentsContent}`;
	} catch {
		return '';
	}
}
