import React from 'react';
import type {ConversationStateManager} from '@/app/utils/conversation-state';
import AgentProgress, {MultiAgentProgress} from '@/components/agent-progress';
import BashProgress from '@/components/bash-progress';
import {ErrorMessage} from '@/components/message-box';
import {type BashExecutionState, bashExecutor} from '@/services/bash-executor';
import {
	clearAllSubagentProgress,
	getSubagentProgress,
	resetSubagentProgressById,
} from '@/services/subagent-events';
import {generateKey} from '@/session/key-generator';
import {MAX_CONCURRENT_AGENTS} from '@/subagents/subagent-executor';
import type {AgentToolArgs} from '@/tools/agent-tool';
import {startAgentExecution} from '@/tools/agent-tool';
import type {ToolManager} from '@/tools/tool-manager';
import type {ToolCall, ToolResult} from '@/types/core';
import {formatError} from '@/utils/error-formatter';
import {
	runStreamingBashTool,
	type StreamingBashRun,
} from '@/utils/streaming-bash-tool';
import {parseToolArguments} from '@/utils/tool-args-parser';
import {
	ALWAYS_EXPANDED_TOOLS,
	type CompactToolActivityMap,
	displayToolResult,
	getCompactToolDetail,
	LIVE_TASK_TOOLS,
} from '@/utils/tool-result-display';

/**
 * Validates and executes a single tool call.
 * Returns the tool call paired with its result for sequential post-processing.
 */
const executeOne = async (
	toolCall: ToolCall,
	processToolUse: (toolCall: ToolCall) => Promise<ToolResult>,
): Promise<{
	toolCall: ToolCall;
	result: ToolResult;
}> => {
	try {
		const result = await processToolUse(toolCall);
		return {toolCall, result};
	} catch (error) {
		return {
			toolCall,
			result: {
				tool_call_id: toolCall.id,
				role: 'tool' as const,
				name: toolCall.function.name,
				content: `Error: ${formatError(error)}`,
			},
		};
	}
};

/**
 * Execute an execute_bash tool call through the shared streaming runner,
 * mounting a live BashProgress so streamed output shows while the command runs.
 * Returns the captured BashExecutionState so the caller can render a completed
 * BashProgress (expanded mode) instead of the command-only formatter.
 */
const executeBashStreaming = async (
	toolCall: ToolCall,
	toolManager: ToolManager | null,
	setLiveComponent: (component: React.ReactNode) => void,
	signal?: AbortSignal,
	onStarted?: (executionId: string, command: string) => void,
): Promise<StreamingBashRun> => {
	const execution = await runStreamingBashTool(
		toolCall,
		toolManager,
		setLiveComponent,
		'direct-bash',
		signal,
		onStarted,
	);
	return {...execution, toolCall};
};

/** Display + conversation-state options shared by every executed tool. */
export interface ToolDisplayOptions {
	compactDisplay?: boolean;
	onCompactToolCount?: (
		toolName: string,
		detail?: string | string[],
		failed?: boolean,
	) => void;
	onLiveTaskUpdate?: () => void;
	onRunningToolCounts?: (counts: CompactToolActivityMap | null) => void;
	nonInteractiveMode?: boolean;
	/**
	 * Called immediately before a "detailed" compact tool line (bash command,
	 * read path) renders, so any pending merged activity summary (omnicode's
	 * "Thought for Ns, ..." line — see conversation-loop's flushCompactCounts)
	 * flushes first and the detailed line appears in the right chronological
	 * spot. No-op for every theme other than omnicode, where there is nothing
	 * pending to flush.
	 */
	onBeforeDetailedToolLine?: () => void;
	/**
	 * Whether the active theme defines assistantIcon (currently only
	 * omnicode) — threaded from useAppState's iconThemeRef snapshot for this
	 * turn. Gates the detailed-line behavior below; every other theme keeps
	 * folding these into the count tally exactly as before.
	 */
	iconTheme?: boolean;
	/**
	 * Live ref to the ctrl+r expand toggle (reasoningExpandedRef). Read at
	 * each display call so the omnicode output preview under a detailed tool
	 * line honors the CURRENT toggle state for newly rendered lines — same
	 * semantics reasoning already has (Ink Static scrollback never
	 * re-renders; ctrl+r changes what subsequent renders show).
	 */
	previewExpandedRef?: React.RefObject<boolean>;
}

const formatAgentProgressTail = (
	agentName: string,
	description: string,
	progress: ReturnType<typeof getSubagentProgress>,
): string[] => {
	const details: string[] = [];
	const statusParts: string[] = [];
	if (progress.currentTool) {
		statusParts.push(`running ${progress.currentTool}`);
	} else if (progress.status === 'running') {
		statusParts.push('thinking');
	} else if (progress.status === 'complete') {
		statusParts.push('complete');
	} else if (progress.status === 'error') {
		statusParts.push('error');
	}
	if (progress.toolCallCount > 0) {
		statusParts.push(
			`${progress.toolCallCount} tool call${progress.toolCallCount === 1 ? '' : 's'}`,
		);
	}
	if (progress.tokenCount > 0) {
		statusParts.push(`~${progress.tokenCount.toLocaleString()} tokens`);
	}

	details.push(
		statusParts.length > 0
			? `${agentName}: ${statusParts.join(' · ')}`
			: `${agentName}: ${description}`,
	);

	for (const toolName of progress.toolHistory.slice(-3)) {
		details.push(`${agentName} → ${toolName}`);
	}

	return details;
};

const formatBashProgressTail = (
	command: string,
	executionId: string,
): string[] => {
	const state = bashExecutor.getState(executionId);
	if (!state) return [command];

	const lines: string[] = [];
	const output = state.outputPreview || state.stderr;
	if (output.trim()) {
		lines.push(...output.trimEnd().split(/\r?\n/).slice(-3));
	} else if (state.error) {
		lines.push(`Error: ${state.error}`);
	} else if (state.isComplete) {
		lines.push(`EXIT_CODE: ${state.exitCode ?? 'unknown'}`);
	} else {
		lines.push(command);
	}

	return lines;
};

/**
 * Execute a single already-approved tool call. execute_bash streams through the
 * live BashProgress when a live area is available; everything else runs through
 * the validated registry handler. The single per-tool execution primitive
 * shared by the auto-execute batch and the (post-approval) confirmation path.
 */
export const executeApprovedTool = (
	toolCall: ToolCall,
	toolManager: ToolManager | null,
	processToolUse: (toolCall: ToolCall) => Promise<ToolResult>,
	setLiveComponent?: (component: React.ReactNode) => void,
	signal?: AbortSignal,
	onBashStarted?: (executionId: string, command: string) => void,
): Promise<StreamingBashRun | {toolCall: ToolCall; result: ToolResult}> => {
	if (toolCall.function.name === 'execute_bash' && setLiveComponent) {
		return executeBashStreaming(
			toolCall,
			toolManager,
			setLiveComponent,
			signal,
			onBashStarted,
		);
	}
	return executeOne(toolCall, processToolUse);
};

/**
 * Render one executed tool's result and fold it into conversation state. The
 * single display primitive shared by both execution paths, so compact-tally,
 * expanded-bash, live-task, and non-interactive rendering behave identically
 * regardless of whether the tool was auto-executed or user-approved.
 */
export const displayExecutedTool = async (
	execution: StreamingBashRun,
	toolManager: ToolManager | null,
	addToChatQueue: (component: React.ReactNode) => void,
	conversationStateManager: React.MutableRefObject<ConversationStateManager>,
	options?: ToolDisplayOptions,
): Promise<void> => {
	const {toolCall, result, bashState} = execution;

	conversationStateManager.current.updateAfterToolExecution(
		toolCall,
		result.content,
	);

	if (
		LIVE_TASK_TOOLS.has(result.name) &&
		!result.content.startsWith('Error: ')
	) {
		// Task tools render in the live area (updating in-place)
		options?.onLiveTaskUpdate?.();
	} else if (
		options?.compactDisplay &&
		!ALWAYS_EXPANDED_TOOLS.has(result.name)
	) {
		// In compact mode, signal the count callback for live display
		// (skip for tools that should always show expanded output).
		//
		// Non-interactive mode has no live tally renderer, so push
		// per-tool one-liners straight to the static queue to keep
		// tool activity in chronological order.
		//
		// Failures (generic "Error: …" or the streaming bash path's
		// "⚒ Validation failed: …") don't fold into the count tally; they
		// render as a condensed red one-liner ("⚒ write_file failed")
		// instead of the full error. The model still receives the full
		// error in conversation history — mirror displayToolResult's detection.
		const isError =
			result.content.startsWith('Error: ') ||
			result.content.startsWith('⚒ Validation failed');

		// Enhanced compact display for file operations (shows path + diff)
		const isFileOp =
			result.name === 'write_file' ||
			result.name === 'string_replace' ||
			result.name === 'diff_edit';

		// Omnicode: every tool with a meaningful primary detail (command,
		// path, pattern, URL, query, …) gets its own detailed line instead of
		// folding into the count tally — see getCompactToolDetail. Gated
		// exclusively on options.iconTheme so every other theme keeps
		// tallying these the way it always has. Tools with no single detail
		// (getCompactToolDetail → null) still tally, even in omnicode.
		const compactToolDetail = getCompactToolDetail(
			result.name,
			toolCall.function.arguments,
		);
		const isDetailedOmnicodeOp =
			Boolean(options.iconTheme) && compactToolDetail !== null;

		const iconDisplay = {
			iconTheme: options.iconTheme,
			expanded: options.previewExpandedRef?.current ?? false,
		};

		if (isError) {
			if (options.nonInteractiveMode) {
				// Non-interactive mode has no live tally renderer, so keep
				// one-line failures in chronological order.
				await displayToolResult(
					toolCall,
					result,
					toolManager,
					addToChatQueue,
					true,
					iconDisplay,
				);
			} else {
				options.onCompactToolCount?.(
					result.name,
					compactToolDetail?.detail,
					true,
				);
			}
		} else if (options.nonInteractiveMode) {
			await displayToolResult(
				toolCall,
				result,
				toolManager,
				addToChatQueue,
				true,
				iconDisplay,
			);
		} else if (isFileOp) {
			// File operations get enhanced compact display with path + diff
			await displayToolResult(
				toolCall,
				result,
				toolManager,
				addToChatQueue,
				true,
				iconDisplay,
			);
		} else if (isDetailedOmnicodeOp) {
			options.onCompactToolCount?.(result.name, compactToolDetail?.detail);
		} else {
			options.onCompactToolCount?.(result.name, compactToolDetail?.detail);
		}
	} else if (result.name === 'execute_bash' && bashState) {
		// Expanded mode: render the completed BashProgress (command +
		// status + tokens), matching the confirmation path's completed view.
		addToChatQueue(
			<BashProgress
				key={generateKey(`direct-bash-complete-${toolCall.id}`)}
				executionId={bashState.executionId}
				command={bashState.command}
				completedState={bashState}
			/>,
		);
	} else {
		// Full display mode
		await displayToolResult(toolCall, result, toolManager, addToChatQueue);
	}
};

/** Classification for grouping tool calls */
type ToolGroup = 'readOnly' | 'agent' | 'other';

/**
 * Classify a tool call for grouping purposes.
 * Read-only tools and agent tools can be parallelized within their groups.
 */
const classifyTool = (
	toolCall: ToolCall,
	toolManager: ToolManager | null,
): ToolGroup => {
	if (toolCall.function.name === 'agent') return 'agent';
	if (toolManager?.isReadOnly(toolCall.function.name)) return 'readOnly';
	return 'other';
};

/**
 * Groups consecutive parallelizable tools for parallel execution.
 * Consecutive read-only tools and consecutive agent tools form parallel groups.
 * Other tools form single-item groups to preserve ordering.
 *
 * Example: [read, read, agent, agent, write, read] →
 *          [[read, read], [agent, agent], [write], [read]]
 */
const groupForParallelExecution = (
	tools: ToolCall[],
	toolManager: ToolManager | null,
): {group: ToolCall[]; type: ToolGroup}[] => {
	const groups: {group: ToolCall[]; type: ToolGroup}[] = [];
	let currentGroup: ToolCall[] = [];
	let currentType: ToolGroup | null = null;

	for (const toolCall of tools) {
		const type = classifyTool(toolCall, toolManager);
		const isParallelizable = type === 'readOnly' || type === 'agent';

		if (isParallelizable && type === currentType) {
			// Continue the current parallelizable group
			currentGroup.push(toolCall);
		} else {
			// Start a new group
			if (currentGroup.length > 0 && currentType !== null) {
				groups.push({group: currentGroup, type: currentType});
			}
			currentGroup = [toolCall];
			currentType = type;
		}
	}

	if (currentGroup.length > 0 && currentType !== null) {
		groups.push({group: currentGroup, type: currentType});
	}

	return groups;
};

/**
 * Execute a batch of agent tool calls in parallel.
 * Returns tool results for all agents.
 */
const executeAgentBatch = async (
	agentToolCalls: ToolCall[],
	toolManager: ToolManager | null,
	addToChatQueue: (component: React.ReactNode) => void,
	compactDisplay?: boolean,
	setLiveComponent?: (component: React.ReactNode) => void,
	onCompactToolCount?: (
		toolName: string,
		detail?: string | string[],
		failed?: boolean,
	) => void,
	onRunningToolCounts?: (counts: CompactToolActivityMap | null) => void,
	nonInteractiveMode?: boolean,
	signal?: AbortSignal,
): Promise<
	Array<{
		toolCall: ToolCall;
		result: ToolResult;
	}>
> => {
	// Enforce concurrency limit — return error results for excess agents
	const excessResults: Array<{toolCall: ToolCall; result: ToolResult}> = [];
	let toExecute = agentToolCalls;
	if (agentToolCalls.length > MAX_CONCURRENT_AGENTS) {
		const excess = agentToolCalls.slice(MAX_CONCURRENT_AGENTS);
		toExecute = agentToolCalls.slice(0, MAX_CONCURRENT_AGENTS);
		for (const toolCall of excess) {
			excessResults.push({
				toolCall,
				result: {
					tool_call_id: toolCall.id,
					role: 'tool' as const,
					name: toolCall.function.name,
					content: `Error: Maximum concurrent agent limit (${MAX_CONCURRENT_AGENTS}) exceeded. Please retry this agent call separately.`,
				},
			});
		}
	}

	// Start all agents
	const agentExecutions = toExecute.map(toolCall => {
		const parsedArgs = parseToolArguments(toolCall.function.arguments);
		// Coerce, don't assert: a weak model can emit these as objects/numbers,
		// and a non-string flowing into the progress UI crashes the renderer.
		const agentName =
			typeof parsedArgs.subagent_type === 'string'
				? parsedArgs.subagent_type
				: 'agent';
		const agentDesc =
			typeof parsedArgs.description === 'string' ? parsedArgs.description : '';

		const {agentId, promise} = startAgentExecution(
			parsedArgs as unknown as AgentToolArgs,
			signal,
		);
		resetSubagentProgressById(agentId);

		return {toolCall, agentId, agentName, agentDesc, promise};
	});

	if (compactDisplay && !nonInteractiveMode && onRunningToolCounts) {
		const counts: CompactToolActivityMap = {};
		for (const e of agentExecutions) {
			const current = counts[e.toolCall.function.name];
			const currentActivity =
				typeof current === 'number' ? {count: current} : current;
			counts[e.toolCall.function.name] = {
				count: (currentActivity?.count ?? 0) + 1,
				details: [
					...(currentActivity?.details ?? []),
					`${e.agentName}: ${e.agentDesc}`,
				],
				liveDetails: () =>
					formatAgentProgressTail(
						e.agentName,
						e.agentDesc,
						getSubagentProgress(e.agentId),
					),
				running: true,
			};
		}
		onRunningToolCounts(counts);
	}

	// Show live progress
	if (
		setLiveComponent &&
		agentExecutions.length > 0 &&
		(!compactDisplay || nonInteractiveMode)
	) {
		const agentInfos = agentExecutions.map(e => ({
			agentId: e.agentId,
			subagentName: e.agentName,
			description: e.agentDesc,
		}));

		if (agentExecutions.length === 1) {
			const e = agentExecutions[0];
			setLiveComponent(
				<AgentProgress
					key={generateKey(`agent-live-direct-${e.toolCall.id}`)}
					subagentName={e.agentName}
					description={e.agentDesc}
					agentId={e.agentId}
					isLive={true}
				/>,
			);
		} else {
			setLiveComponent(
				<MultiAgentProgress
					key={generateKey('multi-agent-live-direct')}
					agents={agentInfos}
					isLive={true}
				/>,
			);
		}
	}

	// Await all results
	const settledResults = await Promise.allSettled(
		agentExecutions.map(e => e.promise),
	);

	// Clear live progress
	setLiveComponent?.(null);

	// Build results
	const results: Array<{toolCall: ToolCall; result: ToolResult}> = [];

	for (let i = 0; i < agentExecutions.length; i++) {
		const e = agentExecutions[i];
		const settled = settledResults[i];

		const agentResult =
			settled.status === 'fulfilled'
				? settled.value
				: {
						content: '',
						success: false,
						error:
							settled.reason instanceof Error
								? settled.reason.message
								: String(settled.reason),
					};

		const progress = getSubagentProgress(e.agentId);

		const result: ToolResult = {
			tool_call_id: e.toolCall.id,
			role: 'tool' as const,
			name: e.toolCall.function.name,
			content: agentResult.success
				? agentResult.content
				: `Error: ${agentResult.error || 'Subagent execution failed'}`,
		};

		results.push({toolCall: e.toolCall, result});

		// Compact: feed into the shared count accumulator so delegated-task
		// summaries group with other tool counts. Errors are still shown in
		// full. Non-compact: render the rich AgentProgress card.
		//
		// Non-interactive mode bypasses the live accumulator (nothing renders
		// it) and pushes a one-liner directly into the static queue so tool
		// activity appears in chronological order in stdout.
		if (compactDisplay) {
			const isError = result.content.startsWith('Error: ');
			if (isError) {
				if (nonInteractiveMode) {
					await displayToolResult(
						e.toolCall,
						result,
						toolManager,
						addToChatQueue,
						true,
					);
				} else {
					onCompactToolCount?.(
						result.name,
						formatAgentProgressTail(e.agentName, e.agentDesc, progress),
						true,
					);
				}
			} else if (nonInteractiveMode) {
				await displayToolResult(
					e.toolCall,
					result,
					toolManager,
					addToChatQueue,
					true,
				);
			} else {
				onCompactToolCount?.(
					result.name,
					formatAgentProgressTail(e.agentName, e.agentDesc, progress),
				);
			}
		} else {
			addToChatQueue(
				<AgentProgress
					key={generateKey(`agent-complete-${e.toolCall.id}`)}
					subagentName={e.agentName}
					description={e.agentDesc}
					agentId={e.agentId}
					completedState={{
						toolCallCount: progress.toolCallCount,
						tokenCount: progress.tokenCount,
						success: agentResult.success,
						toolHistory: [...progress.toolHistory],
					}}
				/>,
			);
		}
	}

	clearAllSubagentProgress();

	// Append error results for excess agents that were rejected
	for (const excess of excessResults) {
		results.push(excess);
		addToChatQueue(
			<ErrorMessage
				key={generateKey(`agent-excess-${excess.toolCall.id}`)}
				message={excess.result.content}
				hideBox={true}
			/>,
		);
	}

	return results;
};

/**
 * Executes tools directly without confirmation.
 * Read-only tools and agent tools in consecutive groups are executed in parallel.
 * Other tools are executed sequentially to preserve ordering.
 * Results are displayed in the original input order.
 *
 * @returns Array of tool results from executed tools
 */
export const executeToolsDirectly = async (
	toolsToExecuteDirectly: ToolCall[],
	toolManager: ToolManager | null,
	conversationStateManager: React.MutableRefObject<ConversationStateManager>,
	addToChatQueue: (component: React.ReactNode) => void,
	options?: {
		compactDisplay?: boolean;
		onCompactToolCount?: (
			toolName: string,
			detail?: string | string[],
			failed?: boolean,
		) => void;
		onLiveTaskUpdate?: () => void;
		onRunningToolCounts?: (counts: CompactToolActivityMap | null) => void;
		setLiveComponent?: (component: React.ReactNode) => void;
		/**
		 * When true, compact tool results push a one-liner directly to the
		 * static chat queue instead of into the live-tally accumulator
		 * (which nothing renders in run mode). Keeps tool activity in
		 * chronological order for stdout.
		 */
		nonInteractiveMode?: boolean;
		/**
		 * Parent turn's abort signal. Threaded into agent batches so a user
		 * cancel (escape) propagates into running subagents.
		 */
		signal?: AbortSignal;
		onBeforeDetailedToolLine?: () => void;
		iconTheme?: boolean;
		previewExpandedRef?: React.RefObject<boolean>;
	},
): Promise<ToolResult[]> => {
	// Import processToolUse here to avoid circular dependencies
	const {processToolUse} = await import('@/message-handler');

	// Group consecutive parallelizable tools
	const groups = groupForParallelExecution(toolsToExecuteDirectly, toolManager);

	const directResults: ToolResult[] = [];

	const showRunningGroup = (group: ToolCall[]) => {
		if (!options?.compactDisplay || !options.onRunningToolCounts) return;
		if (options.nonInteractiveMode || group.length === 0) return;

		const counts: CompactToolActivityMap = {};
		for (const toolCall of group) {
			const toolName = toolCall.function.name;
			const current = counts[toolName];
			const currentActivity =
				typeof current === 'number' ? {count: current} : current;
			const detail = getCompactToolDetail(
				toolName,
				toolCall.function.arguments,
			)?.detail;
			counts[toolName] = {
				count: (currentActivity?.count ?? 0) + 1,
				details: detail
					? [...(currentActivity?.details ?? []), detail]
					: currentActivity?.details,
				running: true,
			};
		}
		options.onRunningToolCounts(counts);
	};

	const clearRunningGroup = () => {
		options?.onRunningToolCounts?.(null);
	};

	for (const {group, type} of groups) {
		let executions: Array<{
			toolCall: ToolCall;
			result: ToolResult;
			bashState?: BashExecutionState;
		}>;

		if (type === 'agent' && group.length > 0) {
			// Parallel execution for consecutive agent tools
			// Note: The promise resolves with the raw agent result. We return the
			// ORIGINAL toolCall (with placeholders) to preserve history.
			const agentResults = await (async () => {
				try {
					return await executeAgentBatch(
						group,
						toolManager,
						addToChatQueue,
						options?.compactDisplay,
						options?.setLiveComponent,
						options?.onCompactToolCount,
						options?.onRunningToolCounts,
						options?.nonInteractiveMode,
						options?.signal,
					);
				} finally {
					clearRunningGroup();
				}
			})();

			// Agent results are already displayed by executeAgentBatch
			for (const {toolCall, result} of agentResults) {
				directResults.push(result);
				conversationStateManager.current.updateAfterToolExecution(
					toolCall,
					result.content,
				);
			}
			continue;
		}

		if (type === 'readOnly' && (group.length > 1 || options?.compactDisplay)) {
			// Parallel execution for consecutive read-only tools
			showRunningGroup(group);
			try {
				executions = await Promise.all(
					group.map(toolCall => executeOne(toolCall, processToolUse)),
				);
			} finally {
				clearRunningGroup();
			}
		} else {
			// Sequential execution for non-parallelizable tools (or single-item groups)
			executions = [];
			for (const toolCall of group) {
				executions.push(
					await executeApprovedTool(
						toolCall,
						toolManager,
						processToolUse,
						options?.setLiveComponent,
						options?.signal,
						(executionId, command) => {
							if (
								!options?.compactDisplay ||
								!options.onRunningToolCounts ||
								options.nonInteractiveMode
							) {
								return;
							}
							options.onRunningToolCounts({
								execute_bash: {
									count: 1,
									details: [command],
									liveDetails: () =>
										formatBashProgressTail(command, executionId),
									running: true,
								},
							});
						},
					),
				);
			}
		}

		// Display results in order
		for (const execution of executions) {
			directResults.push(execution.result);
			await displayExecutedTool(
				execution,
				toolManager,
				addToChatQueue,
				conversationStateManager,
				options,
			);
		}
	}

	return directResults;
};
