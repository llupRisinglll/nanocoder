import {stripVTControlCharacters} from 'node:util';
import {Box, Text} from 'ink';
import React, {useEffect, useReducer} from 'react';
import {computeDiffLines} from '@/components/diff-view/compute';
import DiffView from '@/components/diff-view/DiffView';
import {ErrorMessage} from '@/components/message-box';
import {ToolCallHeader} from '@/components/simple-tool-formatter';
import ToolMessage from '@/components/tool-message';
import {getCompactDiffMaxLines} from '@/config/preferences';
import {DEFAULT_TERMINAL_COLUMNS} from '@/constants';
import {useNonInteractiveRender} from '@/hooks/useNonInteractiveRender';
import {useTerminalWidth} from '@/hooks/useTerminalWidth';
import {useTheme} from '@/hooks/useTheme';
import {generateKey} from '@/session/key-generator';
import {displayForFormat} from '@/tools/tool-aliases';
import type {ToolManager} from '@/tools/tool-manager';
import type {ToolCall, ToolResult} from '@/types/index';
import {parseToolArguments} from '@/utils/tool-args-parser';

/**
 * Tools that should always show expanded (full formatter) output,
 * even when compact display mode is enabled.
 */
export const ALWAYS_EXPANDED_TOOLS = new Set(['write_tasks']);

/**
 * Task tools that should render in the live area (updating in-place)
 * instead of appending to the static chat queue each time.
 */
export const LIVE_TASK_TOOLS = new Set(['write_tasks']);

export interface CompactToolActivity {
	count: number;
	detail?: string;
	details?: string[];
	liveDetails?: () => string[];
	failed?: boolean;
	running?: boolean;
}

export type CompactToolActivityMap = Record<
	string,
	number | CompactToolActivity
>;

type CompactToolCountsInput = CompactToolActivityMap;

function normalizeCompactToolEntries(
	counts: CompactToolCountsInput,
): Array<[string, CompactToolActivity]> {
	return Object.entries(counts).map(([toolName, value]) => [
		toolName.endsWith(':running')
			? toolName.slice(0, -':running'.length)
			: toolName.endsWith(':failed')
				? toolName.slice(0, -':failed'.length)
				: toolName,
		typeof value === 'number' ? {count: value} : value,
	]);
}

function mergeCompactToolEntries(
	entries: Array<[string, CompactToolActivity]>,
): {
	entries: Array<[string, CompactToolActivity]>;
	hasRunning: boolean;
} {
	let hasRunning = false;
	const mergedEntries = Array.from(
		entries
			.reduce((merged, [toolName, activity]) => {
				hasRunning ||= Boolean(activity.running);
				const current = merged.get(toolName);
				merged.set(toolName, {
					count: (current?.count ?? 0) + activity.count,
					detail: current?.detail ?? activity.detail,
					details: [...(current?.details ?? []), ...(activity.details ?? [])],
					liveDetails:
						current?.liveDetails || activity.liveDetails
							? () => [
									...(current?.liveDetails?.() ?? []),
									...(activity.liveDetails?.() ?? []),
								]
							: undefined,
					failed: current?.failed ?? activity.failed,
					running: current?.running || activity.running,
				});
				return merged;
			}, new Map<string, CompactToolActivity>())
			.entries(),
	);

	return {entries: mergedEntries, hasRunning};
}

function getCompactDisplayToolName(toolName: string): string {
	return displayForFormat(toolName, 'claude-code');
}

function ToolGlyph({running = false}: {running?: boolean}) {
	const {colors} = useTheme();
	return (
		<>
			<Text color={running ? colors.text : colors.primary}>{'\u2692'} </Text>
			<Text> </Text>
		</>
	);
}

/** Compact tool result display - shows "⚒  toolName ×N". */
function CompactToolResult({
	toolName,
	count = 1,
	failed = false,
}: {
	toolName: string;
	count?: number;
	failed?: boolean;
}) {
	const {colors} = useTheme();
	return (
		<Text>
			<ToolGlyph />
			<Text color={colors.primary}>{getCompactDisplayToolName(toolName)}</Text>
			{count > 1 && <Text color={colors.text}> ×{count}</Text>}
			{failed && <Text color={colors.error}> failed</Text>}
		</Text>
	);
}

function formatGroupedToolEntries(
	entries: Array<[string, CompactToolActivity]>,
	textColor: string,
): React.ReactNode[] {
	const nodes: React.ReactNode[] = [];
	for (let index = 0; index < entries.length; index++) {
		const [toolName, activity] = entries[index];
		const isLast = index === entries.length - 1;
		const separator =
			index === 0 ? '' : isLast && entries.length > 1 ? ' and ' : ', ';
		nodes.push(
			<React.Fragment key={toolName}>
				{separator && <Text color={textColor}>{separator}</Text>}
				<ToolNameWithCount
					toolName={toolName}
					count={activity.count}
					failed={activity.failed}
				/>
			</React.Fragment>,
		);
	}
	return nodes;
}

function formatToolNameWithCountText(
	toolName: string,
	activity: CompactToolActivity,
): string {
	let text = getCompactDisplayToolName(toolName);
	if (activity.count > 1) text += ` ×${activity.count}`;
	if (activity.failed) text += ' failed';
	return text;
}

function formatGroupedToolEntriesText(
	entries: Array<[string, CompactToolActivity]>,
): string {
	return entries
		.map(([toolName, activity]) =>
			formatToolNameWithCountText(toolName, activity),
		)
		.reduce((text, part, index) => {
			if (index === 0) return part;
			if (index === entries.length - 1) return `${text} and ${part}`;
			return `${text}, ${part}`;
		}, '');
}

export function getCompactToolCountsHeaderText(
	entries: Array<[string, number | CompactToolActivity]>,
	running = false,
): string {
	const normalizedEntries = entries.map(([toolName, value]) => [
		toolName,
		typeof value === 'number' ? {count: value} : value,
	]) as Array<[string, CompactToolActivity]>;
	const singleInline =
		normalizedEntries.length === 1 &&
		normalizedEntries[0]?.[1].count === 1 &&
		normalizedEntries[0]?.[1].detail;

	if (singleInline) {
		return `⚒  ${formatToolNameWithCountText(normalizedEntries[0][0], normalizedEntries[0][1])}(${truncateDetail(normalizedEntries[0][1].detail ?? '')})`;
	}

	return `⚒  ${running ? 'Running ' : 'Ran '}${formatGroupedToolEntriesText(normalizedEntries)}`;
}

function ToolNameWithCount({
	toolName,
	count,
	failed,
}: {
	toolName: string;
	count: number;
	failed?: boolean;
}) {
	const {colors} = useTheme();
	return (
		<>
			<Text color={colors.primary}>{getCompactDisplayToolName(toolName)}</Text>
			{count > 1 && <Text color={colors.text}> ×{count}</Text>}
			{failed && <Text color={colors.error}> failed</Text>}
		</>
	);
}

/** Compact grouped tool display - shows "⚒ toolA ×N, toolB ×N". */
export function CompactToolCountsLine({
	entries,
	running = false,
}: {
	entries: Array<[string, number | CompactToolActivity]>;
	running?: boolean;
}) {
	const {colors} = useTheme();
	const normalizedEntries = entries.map(([toolName, value]) => [
		toolName,
		typeof value === 'number' ? {count: value} : value,
	]) as Array<[string, CompactToolActivity]>;
	const singleInline =
		normalizedEntries.length === 1 &&
		normalizedEntries[0]?.[1].count === 1 &&
		normalizedEntries[0]?.[1].detail;

	return (
		<Text>
			<ToolGlyph running={running} />
			{singleInline ? (
				<>
					<ToolNameWithCount
						toolName={normalizedEntries[0][0]}
						count={normalizedEntries[0][1].count}
						failed={normalizedEntries[0][1].failed}
					/>
					<Text color={colors.secondary}>(</Text>
					<Text color={colors.text}>
						{truncateDetail(normalizedEntries[0][1].detail ?? '')}
					</Text>
					<Text color={colors.secondary}>)</Text>
				</>
			) : (
				<>
					<Text color={colors.text}>{running ? 'Running ' : 'Ran '}</Text>
					{formatGroupedToolEntries(normalizedEntries, colors.text)}
				</>
			)}
		</Text>
	);
}

function truncateDetail(value: string, max = 80): string {
	const single = value.replace(/\s+/g, ' ').trim();
	return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

function compactRunningDetailLines(
	entries: Array<[string, CompactToolActivity]>,
	options?: {runningOnly?: boolean; expanded?: boolean},
	maxLines = 3,
): {
	lines: string[];
	hiddenCount: number;
} {
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const [, activity] of entries) {
		if (options?.runningOnly && !activity.running) continue;
		const details = [
			...(activity.details ?? []),
			...(activity.liveDetails?.() ?? []),
		];
		for (const detail of details) {
			const normalized = truncateDetail(detail, 110);
			if (!normalized || seen.has(normalized)) continue;
			seen.add(normalized);
			lines.push(normalized);
		}
	}

	const displayed = options?.expanded ? lines : lines.slice(-maxLines);
	return {
		lines: displayed,
		hiddenCount: Math.max(0, lines.length - displayed.length),
	};
}

export function getCompactToolExpandHintText(expanded: boolean): string {
	return `(ctrl-o to ${expanded ? 'collapse' : 'expand'})`;
}

export function getLiveCompactToolExpandHitboxColumns(
	counts: CompactToolCountsInput,
	expanded = false,
): {start: number; end: number} | null {
	const normalizedEntries = normalizeCompactToolEntries(counts);
	if (normalizedEntries.length === 0) return null;
	const {entries, hasRunning} = mergeCompactToolEntries(normalizedEntries);
	const headerText = getCompactToolCountsHeaderText(entries);
	const runningText = hasRunning ? ' (running)' : '';
	const start = headerText.length + runningText.length + 2;
	return {
		start,
		end: start + getCompactToolExpandHintText(expanded).length - 1,
	};
}

function CompactToolExpandHint({
	expanded,
	hovered = false,
}: {
	expanded: boolean;
	hovered?: boolean;
}) {
	const {colors} = useTheme();
	return (
		<Text
			color={hovered ? colors.text : colors.secondary}
			backgroundColor={hovered ? colors.secondary : undefined}
		>
			{' '}
			{getCompactToolExpandHintText(expanded)}
		</Text>
	);
}

/**
 * Compact tool error display - shows "\u2692 toolName failed" in error red.
 * Used in compact display mode so failures don't dump the full verbose
 * error; the model still receives the full error in conversation history,
 * so this only trims what the user sees.
 */
function CompactToolError({toolName}: {toolName: string}) {
	return <CompactToolResult toolName={toolName} failed={true} />;
}

interface CompactFileResultProps {
	toolName: 'write_file' | 'string_replace' | 'diff_edit';
	path: string;
	oldStr?: string;
	newStr?: string;
}

/**
 * Enhanced compact display for file operations.
 * Shows file path, line count changes, and a git-style inline diff with line numbers.
 * Wraps in ToolMessage to match the design system.
 */
function CompactFileResult({
	toolName,
	path,
	oldStr,
	newStr,
}: CompactFileResultProps) {
	const {colors} = useTheme();

	const newLines = newStr?.split('\n') ?? [];
	const oldLines = oldStr?.split('\n') ?? [];

	const rangeDesc =
		toolName === 'write_file'
			? `${newLines.length} line${newLines.length !== 1 ? 's' : ''}`
			: `${oldLines.length} line${oldLines.length !== 1 ? 's' : ''} \u2192 ${newLines.length} line${newLines.length !== 1 ? 's' : ''}`;

	const displayName = toolName === 'write_file' ? 'Write' : 'Edit';

	const terminalWidth = process.stdout.columns || DEFAULT_TERMINAL_COLUMNS;
	const configuredMaxLines = getCompactDiffMaxLines();
	const maxLines = configuredMaxLines === 0 ? undefined : configuredMaxLines;

	let diffBody: React.ReactElement | null = null;

	if (
		(toolName === 'string_replace' || toolName === 'diff_edit') &&
		oldStr &&
		newStr
	) {
		const diffLines = computeDiffLines(oldStr, newStr);
		diffBody = (
			<DiffView
				lines={diffLines}
				width={terminalWidth}
				maxLines={maxLines}
				filePath={path}
			/>
		);
	} else if (toolName === 'write_file' && newStr) {
		// No prior file content is available at this call site — write_file
		// invalidates the read cache before the compact result renders, so
		// there's nothing to diff against. Keep the existing first-N-lines
		// preview rather than inventing snapshot plumbing to fabricate an
		// all-additions diff.
		const previewCount = Math.min(newLines.length, 3);
		const previewElements: React.ReactElement[] = [];
		for (let i = 0; i < previewCount; i++) {
			const lineNumStr = String(i + 1).padStart(4, ' ');
			previewElements.push(
				<Box key={`line-${i}`}>
					<Text wrap="truncate-end">
						{lineNumStr} {newLines[i]}
					</Text>
				</Box>,
			);
		}
		if (newLines.length > 3) {
			previewElements.push(
				<Text key="more" color={colors.secondary}>
					...{newLines.length - 3} more lines
				</Text>,
			);
		}
		diffBody = <Box flexDirection="column">{previewElements}</Box>;
	}

	const message = (
		<Box flexDirection="column">
			<Box>
				<ToolGlyph />
				<Text color={colors.primary} bold>
					{getCompactDisplayToolName(toolName)}
				</Text>
				<Text color={colors.secondary}> </Text>
				<Text wrap="truncate-end" color={colors.text}>
					{path}
				</Text>
			</Box>
			<Box>
				<Text color={colors.secondary}> {'\u23bf'} </Text>
				<Text color={colors.secondary}>{displayName}: </Text>
				<Text color={colors.text}>{rangeDesc}</Text>
			</Box>
			{diffBody}
		</Box>
	);

	return <ToolMessage message={message} hideBox={true} />;
}

/** Flatten a multi-line value into a single displayable line. */
function flattenToOneLine(value: string): string {
	return value.replace(/\s*\r?\n\s*/g, ' ').trim();
}

/**
 * Extract the primary detail for omnicode's detailed compact tool lines:
 * "⚒ <tool_name>(<detail>)" (e.g. "⚒ git_diff(git diff --staged)",
 * "⚒ fetch_url(https://…)"). Returns null for tools with no meaningful single
 * detail — those keep the count tally.
 */
export function getCompactToolDetail(
	toolName: string,
	rawArgs: unknown,
): {detail: string} | null {
	const args = parseToolArguments<Record<string, unknown>>(rawArgs);
	const str = (v: unknown): string | undefined =>
		typeof v === 'string' && v.trim() ? v : undefined;

	switch (toolName) {
		case 'execute_bash': {
			const command = str(args.command);
			return command ? {detail: command} : null;
		}
		case 'read_file': {
			const path = str(args.path) ?? str(args.file_path);
			return path ? {detail: path} : null;
		}
		case 'git_status':
			return {detail: 'git status'};
		case 'git_diff': {
			// Synthesize the equivalent git invocation from the structured args
			// so the user sees what actually ran.
			const parts = ['git diff'];
			if (args.staged === true) parts.push('--staged');
			if (args.stat === true) parts.push('--stat');
			const base = str(args.base);
			if (base) parts.push(base);
			const file = str(args.file);
			if (file) parts.push(file);
			return {detail: parts.join(' ')};
		}
		case 'git_log': {
			const parts = ['git log'];
			if (typeof args.count === 'number') parts.push(`-n ${args.count}`);
			const author = str(args.author);
			if (author) parts.push(`--author=${author}`);
			const since = str(args.since);
			if (since) parts.push(`--since=${since}`);
			const file = str(args.file);
			if (file) parts.push(file);
			return {detail: parts.join(' ')};
		}
		case 'search_file_contents': {
			const query = str(args.query) ?? str(args.pattern);
			return query ? {detail: query} : null;
		}
		case 'find_files': {
			const pattern = str(args.pattern) ?? str(args.query);
			return pattern ? {detail: pattern} : null;
		}
		case 'list_directory': {
			const path = str(args.path) ?? '.';
			return {detail: path};
		}
		case 'fetch_url': {
			const url = str(args.url);
			return url ? {detail: url} : null;
		}
		case 'web_search': {
			const query = str(args.query);
			return query ? {detail: query} : null;
		}
		case 'ask_question': {
			const question = str(args.question);
			return question ? {detail: question} : null;
		}
		case 'agent': {
			const subagent = str(args.subagent_type);
			const description = str(args.description);
			if (subagent && description)
				return {detail: `${subagent}: ${description}`};
			return subagent || description
				? {detail: subagent ?? description ?? ''}
				: null;
		}
		case 'skill':
		case 'check_skill': {
			const name = str(args.name);
			return name ? {detail: name} : null;
		}
		case 'lsp_get_diagnostics': {
			const path = str(args.path) ?? str(args.file_path);
			return path ? {detail: path} : null;
		}
		default:
			// Unknown / MCP / no-single-detail tools keep the count tally.
			return null;
	}
}

// Preview sizing for CompactDetailResult (omnicode). Collapsed shows the
// first few lines Claude-Code style; expanded shows more but stays capped so
// a read of a 300-line file can't dump the entire body into scrollback.
const PREVIEW_COLLAPSED_LINES = 3;
const PREVIEW_EXPANDED_LINES = 50;

/**
 * Detailed compact display for omnicode: one "⚒ <toolName>(<detail>)" line
 * (actual command / path / pattern / URL — the user's security-visibility
 * ask), optionally followed by a "⎿"-prefixed preview of the tool's output
 * and a "… +N lines (ctrl+r to expand)" hint when truncated. Single header
 * line, flattened newlines, truncated to terminal width.
 *
 * `expanded` is captured at queue time from reasoningExpandedRef — exactly
 * how AssistantReasoning's expand works: ctrl+r changes what SUBSEQUENT
 * renders show; already-queued static scrollback never re-renders (Ink
 * Static).
 */
function CompactDetailResult({
	toolName,
	detail,
	output,
	expanded,
}: {
	toolName: string;
	detail: string;
	output?: string;
	expanded?: boolean;
}) {
	const {colors} = useTheme();
	const boxWidth = useTerminalWidth();
	const nonInteractive = useNonInteractiveRender();
	const flatDetail = flattenToOneLine(detail);

	// Build the output preview: strip ANSI so escape codes from bash output
	// can't corrupt the layout, drop trailing blank lines, cap line count.
	let previewLines: string[] = [];
	let hiddenCount = 0;
	if (output) {
		const allLines = stripVTControlCharacters(output)
			.replace(/\r\n/g, '\n')
			.replace(/\s+$/, '')
			.split('\n');
		const cap = expanded ? PREVIEW_EXPANDED_LINES : PREVIEW_COLLAPSED_LINES;
		previewLines = allLines.slice(0, cap);
		hiddenCount = allLines.length - previewLines.length;
	}

	return (
		<Box flexDirection="column" width={boxWidth}>
			<ToolCallHeader
				toolName={getCompactDisplayToolName(toolName)}
				detail={flatDetail}
			/>
			{previewLines.map((line, i) => (
				<Box key={`preview-${i}-${line.slice(0, 16)}`}>
					<Text color={colors.secondary}>{i === 0 ? ' ⎿ ' : '   '}</Text>
					<Text wrap="truncate-end" color={colors.secondary}>
						{line || ' '}
					</Text>
				</Box>
			))}
			{hiddenCount > 0 && (
				<Text color={colors.secondary}>
					{'   '}… +{hiddenCount} line{hiddenCount === 1 ? '' : 's'}
					{!nonInteractive && !expanded ? ' (ctrl+r to expand)' : ''}
				</Text>
			)}
		</Box>
	);
}

/**
 * Generate a compact grouped description for N calls of the same tool.
 * Always uses count-based phrasing for consistency.
 */
export function getGroupedCompactDescription(
	toolName: string,
	count: number | CompactToolActivity,
): string {
	const value = typeof count === 'number' ? count : count.count;
	return value === 1 ? toolName : `${toolName} ×${value}`;
}

/**
 * Live display component for running compact tool counts.
 * Shows accumulated counts during execution (e.g. "⚒ read_file ×7").
 * Rendered in the live area (not Static) so it updates in-place.
 */
export function LiveCompactCounts({
	counts,
	expanded = false,
	expandHintHovered = false,
}: {
	counts: CompactToolCountsInput;
	expanded?: boolean;
	expandHintHovered?: boolean;
}) {
	const entries = normalizeCompactToolEntries(counts);
	const {entries: mergedEntries, hasRunning} = mergeCompactToolEntries(entries);
	const {colors} = useTheme();
	const hasLiveDetails = mergedEntries.some(([, activity]) =>
		Boolean(activity.liveDetails),
	);
	const [, forceRender] = useReducer((x: number) => x + 1, 0);

	useEffect(() => {
		if (!hasRunning || !hasLiveDetails) return;
		const interval = setInterval(() => {
			forceRender();
		}, 100);
		return () => clearInterval(interval);
	}, [hasRunning, hasLiveDetails]);

	const detailPreview = compactRunningDetailLines(mergedEntries, {
		expanded,
		runningOnly: hasRunning,
	});

	return (
		<Box flexDirection="column" marginBottom={1}>
			{mergedEntries.length > 0 && (
				<Text>
					<CompactToolCountsLine entries={mergedEntries} />
					{hasRunning && <Text color={colors.secondary}> (running)</Text>}
					<CompactToolExpandHint
						expanded={expanded}
						hovered={expandHintHovered}
					/>
				</Text>
			)}
			{detailPreview.lines.map((line, index) => (
				<Text key={`${index}-${line.slice(0, 24)}`}>
					<Text color={colors.secondary}>
						{index === 0 ? '  └  ' : '     '}
					</Text>
					<Text color={colors.text}>{line}</Text>
				</Text>
			))}
			{detailPreview.hiddenCount > 0 && (
				<Text color={colors.secondary}>
					{'     '}… +{detailPreview.hiddenCount} more command
					{detailPreview.hiddenCount === 1 ? '' : 's'}
				</Text>
			)}
		</Box>
	);
}

/**
 * Flush accumulated compact counts to the static chat queue.
 * Called when the conversation loop finishes to persist the summary.
 */
export function displayCompactCountsSummary(
	counts: CompactToolCountsInput,
	addToChatQueue: (component: React.ReactNode) => void,
	options?: {indent?: boolean; expanded?: boolean},
): void {
	const entries = normalizeCompactToolEntries(counts);
	if (entries.length === 0) return;

	// Indent the summary so it visually groups beneath its Thought header.
	// When no Thought precedes it (non-thinking models), render flat so the
	// summary doesn't look orphaned. marginBottom keeps spacing between turn
	// groups.
	const indent = options?.indent ?? true;
	addToChatQueue(
		<CompactToolCountsSummaryBlock
			key={generateKey('tool-compact-summary')}
			entries={entries}
			expanded={options?.expanded ?? false}
			indent={indent}
		/>,
	);
}

// Rendered as a component so it can read the theme: icon-style themes
// (assistantIcon set) keep tool tallies flush left instead of grouping them
// under a Thought header with an indent.
export function CompactToolCountsSummaryBlock({
	expanded,
	entries,
	indent,
	expandHintHovered = false,
}: {
	expanded: boolean;
	entries: Array<[string, number | CompactToolActivity]>;
	indent: boolean;
	expandHintHovered?: boolean;
}) {
	const {colors} = useTheme();
	const normalizedEntries = entries.map(([toolName, value]) => [
		toolName,
		typeof value === 'number' ? {count: value} : value,
	]) as Array<[string, CompactToolActivity]>;
	const detailPreview = compactRunningDetailLines(normalizedEntries, {
		expanded,
	});
	return (
		<Box
			flexDirection="column"
			marginLeft={indent && !colors.assistantIcon ? 2 : 0}
			marginBottom={1}
		>
			<Text>
				<CompactToolCountsLine entries={entries} />
				<CompactToolExpandHint
					expanded={expanded}
					hovered={expandHintHovered}
				/>
			</Text>
			{detailPreview.lines.map((line, index) => (
				<Text key={`${index}-${line.slice(0, 24)}`}>
					<Text color={colors.secondary}>
						{index === 0 ? '  └  ' : '     '}
					</Text>
					<Text color={colors.text}>{line}</Text>
				</Text>
			))}
			{detailPreview.hiddenCount > 0 && (
				<Text color={colors.secondary}>
					{'     '}… +{detailPreview.hiddenCount} more command
					{detailPreview.hiddenCount === 1 ? '' : 's'}
				</Text>
			)}
		</Box>
	);
}

/**
 * Display tool result with proper formatting
 * Extracted to eliminate duplication between useChatHandler and useToolHandler
 *
 * @param toolCall - The tool call that was executed
 * @param result - The result from tool execution
 * @param toolManager - The tool manager instance (for formatters)
 * @param addToChatQueue - Function to add components to chat queue
 * @param compact - When true, show one-liner instead of full formatter output
 * @param iconDisplay - Omnicode display options. `iconTheme` gates the
 *   detailed-line compact fallback (actual command / path / pattern with
 *   output preview); every other theme (the default, undefined) keeps the
 *   classic count-based one-liner. `expanded` (from reasoningExpandedRef at
 *   queue time) widens the output preview, mirroring reasoning's ctrl+r
 *   semantics.
 */
export async function displayToolResult(
	toolCall: ToolCall,
	result: ToolResult,
	toolManager: ToolManager | null,
	addToChatQueue: (component: React.ReactNode) => void,
	compact?: boolean,
	iconDisplay?: {iconTheme?: boolean; expanded?: boolean},
): Promise<void> {
	const iconTheme = iconDisplay?.iconTheme ?? false;
	// Check if this is an error result. Generic failures are prefixed "Error: ";
	// validation failures (bad arg types, failed per-tool validators) come back
	// as "⚒ Validation failed: …" — both should render as a red error so the
	// user sees the same feedback the model gets.
	const isValidationError = result.content.startsWith('⚒ Validation failed');
	const isError = result.content.startsWith('Error: ') || isValidationError;

	if (isError) {
		// Compact mode: condense failures to a short red one-liner
		// ("⚒ write_file ") instead of the full error output.
		// The model still receives the full error in conversation history,
		// so this only trims the user-facing display.
		if (compact && !ALWAYS_EXPANDED_TOOLS.has(result.name)) {
			addToChatQueue(
				<CompactToolError
					key={generateKey(`tool-error-compact-${result.tool_call_id}`)}
					toolName={result.name}
				/>,
			);
			return;
		}

		// Display as error message - shown in full
		const errorMessage = isValidationError
			? result.content
			: result.content.replace(/^Error: /, '');
		addToChatQueue(
			<ErrorMessage
				key={generateKey(`tool-error-${result.tool_call_id}`)}
				message={errorMessage}
				hideBox={true}
			/>,
		);
		return;
	}

	// Compact mode: show count-based one-liner instead of full formatter output
	// (skip for tools that should always show expanded output)
	if (compact && !ALWAYS_EXPANDED_TOOLS.has(result.name)) {
		// Enhanced compact display for file operations
		if (
			result.name === 'write_file' ||
			result.name === 'string_replace' ||
			result.name === 'diff_edit'
		) {
			const parsedArgs = parseToolArguments<{
				path?: string;
				file_path?: string;
				old_str?: string;
				new_str?: string;
				content?: string;
				diff?: string;
			}>(toolCall.function.arguments);
			const path = parsedArgs.path || parsedArgs.file_path || 'unknown';

			// For diff_edit, extract old/new from diff format
			let oldStr = parsedArgs.old_str;
			let newStr = parsedArgs.content || parsedArgs.new_str;
			if (result.name === 'diff_edit' && parsedArgs.diff) {
				// Parse diff format: <<<<<<< SEARCH / ======= / >>>>>>> REPLACE
				const parts = parsedArgs.diff.split('=======\n');
				if (parts.length === 2) {
					oldStr = parts[0].replace('<<<<<<< SEARCH\n', '').trim();
					newStr = parts[1].replace('>>>>>>> REPLACE', '').trim();
				}
			}

			addToChatQueue(
				<CompactFileResult
					key={generateKey(`tool-compact-${result.tool_call_id}`)}
					toolName={result.name}
					path={path}
					oldStr={oldStr}
					newStr={newStr}
				/>,
			);
			return;
		}

		// Omnicode: show the tool's primary detail (actual command / path /
		// pattern / URL) instead of a generic count-based line, so the user
		// sees what ran (security motivation), plus a "⎿" output preview with
		// an expand hint. Gated exclusively on iconTheme — every other theme
		// keeps the generic CompactToolResult fallback below. Tools with no
		// meaningful single detail (getCompactToolDetail → null) also fall
		// through to the tally.
		if (iconTheme) {
			const toolDetail = getCompactToolDetail(
				result.name,
				toolCall.function.arguments,
			);
			if (toolDetail) {
				addToChatQueue(
					<CompactDetailResult
						key={generateKey(`tool-compact-${result.tool_call_id}`)}
						toolName={result.name}
						detail={toolDetail.detail}
						output={result.content}
						expanded={iconDisplay?.expanded ?? false}
					/>,
				);
				return;
			}
		}

		addToChatQueue(
			<CompactToolResult
				key={generateKey(`tool-compact-${result.tool_call_id}`)}
				toolName={result.name}
			/>,
		);
		return;
	}

	if (toolManager) {
		const formatter = toolManager.getToolFormatter(result.name);
		if (formatter) {
			try {
				const parsedArgs = parseToolArguments(toolCall.function.arguments);
				const formattedResult = await formatter(parsedArgs, result.content);

				if (React.isValidElement(formattedResult)) {
					addToChatQueue(
						React.cloneElement(formattedResult, {
							key: generateKey(`tool-result-${result.tool_call_id}`),
						}),
					);
				} else {
					addToChatQueue(
						<ToolMessage
							key={generateKey(`tool-result-${result.tool_call_id}`)}
							title={`⚒ ${result.name}`}
							message={String(formattedResult)}
							hideBox={true}
						/>,
					);
				}
			} catch {
				// If formatter fails, show raw result
				addToChatQueue(
					<ToolMessage
						key={generateKey(`tool-result-${result.tool_call_id}`)}
						title={`⚒ ${result.name}`}
						message={result.content}
						hideBox={true}
					/>,
				);
			}
		} else {
			// No formatter, show raw result
			addToChatQueue(
				<ToolMessage
					key={generateKey(`tool-result-${result.tool_call_id}`)}
					title={`⚒ ${result.name}`}
					message={result.content}
					hideBox={true}
				/>,
			);
		}
	}
}
