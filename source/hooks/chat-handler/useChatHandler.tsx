import React from 'react';
import {appendToolDefinitionsToPrompt} from '@/ai-sdk-client/tools/system-prompt-assembler';
import {ConversationStateManager} from '@/app/utils/conversation-state';
import UserMessage from '@/components/user-message';
import {getAppConfig} from '@/config/index';
import {CommandIntegration} from '@/custom-commands/command-integration';
import {generateKey} from '@/session/key-generator';
import {formatAvailableSkillsForPrompt} from '@/skills/prompt';
import {getTuneToolMode} from '@/types/config';
import type {ImageAttachment, Message} from '@/types/core';
import {MessageBuilder} from '@/utils/message-builder';
import {infoMsg} from '@/utils/message-factory';
import {
	type BuiltPromptBlock,
	buildSystemPromptBlocks,
	setLastBuiltPrompt,
} from '@/utils/prompt-builder';
import {processAssistantResponse} from './conversation/conversation-loop';
import {createResetStreamingState} from './state/streaming-state';
import type {ChatHandlerReturn, UseChatHandlerProps} from './types';
import {displayError as displayErrorHelper} from './utils/message-helpers';

type CachedPrompt = {
	prompt: string;
	blocks: BuiltPromptBlock[];
};

type CachedPromptInput = string | CachedPrompt | null;

function normalizeCachedPrompt(input: CachedPromptInput): CachedPrompt | null {
	if (!input) return null;
	if (typeof input === 'string') {
		return {
			prompt: input,
			blocks: [{text: input, cacheScope: 'volatile'}],
		};
	}
	return input;
}

function buildSkillsPromptBlock(): BuiltPromptBlock | null {
	const text = formatAvailableSkillsForPrompt();
	return text ? {text, cacheScope: 'stable'} : null;
}

function buildMCPInstructionsBlock(
	toolManager: NonNullable<UseChatHandlerProps['toolManager']>,
): BuiltPromptBlock | null {
	const instructions = toolManager.getMCPInstructions();
	if (instructions.length === 0) return null;
	return {
		cacheScope: 'stable',
		text: [
			'<mcp_instructions>',
			...instructions.flatMap(item => [
				`  <server name="${item.name}">`,
				...item.instructions.split('\n').map(line => `    ${line}`),
				'  </server>',
			]),
			'</mcp_instructions>',
		].join('\n'),
	};
}

function promptFromBlocks(blocks: BuiltPromptBlock[]): string {
	return blocks
		.map(b => b.text)
		.filter(Boolean)
		.join('\n\n');
}

export function getBaseSystemPrompt(
	developmentMode: UseChatHandlerProps['developmentMode'],
	cachedBasePrompt: CachedPromptInput,
	toolManager: NonNullable<UseChatHandlerProps['toolManager']>,
	tune: UseChatHandlerProps['tune'],
	toolsDisabled: boolean,
	model?: string,
): string {
	return getBaseSystemPromptState(
		developmentMode,
		cachedBasePrompt,
		toolManager,
		tune,
		toolsDisabled,
		model,
	).prompt;
}

function getBaseSystemPromptState(
	developmentMode: UseChatHandlerProps['developmentMode'],
	cachedBasePrompt: CachedPromptInput,
	toolManager: NonNullable<UseChatHandlerProps['toolManager']>,
	tune: UseChatHandlerProps['tune'],
	toolsDisabled: boolean,
	model?: string,
): CachedPrompt {
	const systemPromptOverride = getAppConfig().systemPrompt;
	const mode = developmentMode ?? 'normal';

	const normalized = normalizeCachedPrompt(cachedBasePrompt);
	if (developmentMode !== 'headless' && normalized) {
		return normalized;
	}

	const availableNames = toolManager.getAvailableToolNames(
		tune,
		mode,
		undefined,
		model,
	);
	const blocks = buildSystemPromptBlocks(
		mode,
		tune,
		availableNames,
		toolsDisabled,
		systemPromptOverride,
		model,
	);
	const skillsBlock = buildSkillsPromptBlock();
	if (skillsBlock) blocks.push(skillsBlock);
	const mcpBlock = buildMCPInstructionsBlock(toolManager);
	if (mcpBlock) blocks.push(mcpBlock);
	return {
		blocks,
		prompt: promptFromBlocks(blocks),
	};
}

/**
 * Main chat handler hook that manages LLM conversations and tool execution.
 * Orchestrates streaming responses, tool calls, and conversation state.
 */
export function useChatHandler({
	client,
	toolManager,
	customCommandLoader,
	messages,
	setMessages,
	currentProvider,
	currentModel,
	setIsCancelling,
	addToChatQueue,
	abortController,
	setAbortController,
	developmentMode = 'normal',
	developmentModeRef,
	nonInteractiveMode = false,
	onConversationComplete,
	onPlanTurnComplete,
	reasoningExpandedRef,
	iconThemeRef,
	compactToolDisplayRef,
	onSetCompactToolCounts,
	compactToolCountsRef,
	onSetLiveTaskList,
	setLiveComponent,
	setLastApiUsage,
	onApiCallComplete,
	tune,
	subagentsReady,
	privacySessionMapRef,
	privacyEnabled,
}: UseChatHandlerProps): ChatHandlerReturn {
	// Conversation state manager for enhanced context
	const conversationStateManager = React.useRef(new ConversationStateManager());

	// Resolve the active fallback format when native tools are disabled. When
	// native is on, this value is unused. The tune override takes priority over
	// provider-level disables so users can pick the JSON path explicitly even
	// for providers we'd otherwise mark as XML-only.
	const tuneToolMode = React.useMemo(() => getTuneToolMode(tune), [tune]);

	// Check if native tool calling is disabled (provider config or tune override)
	const toolsDisabled = React.useMemo(() => {
		if (tuneToolMode !== 'native') return true;
		const config = getAppConfig();
		const provider = config.providers?.find(p => p.name === currentProvider);
		if (!provider) return false;
		return (
			provider.disableTools === true ||
			(provider.disableToolModels?.includes(currentModel) ?? false)
		);
	}, [currentProvider, currentModel, tuneToolMode]);

	// When native is off, the fallback format is whatever the tune chose; if the
	// disable came from provider config (and tune is on 'native'), default to XML
	// to match historical behaviour.
	const fallbackToolFormat: 'xml' | 'json' =
		tuneToolMode === 'json' ? 'json' : 'xml';

	// Cache the base system prompt — only rebuild when mode, tune, tools, or toolsDisabled change
	// This preserves KV cache by keeping the system message stable across turns
	// When native tools are disabled, XML tool definitions are included in the prompt
	// so token counting reflects the full system message the model actually sees.
	// biome-ignore lint/correctness/useExhaustiveDependencies: subagentsReady isn't read in the callback, but flipping it must invalidate the memo so buildSystemPrompt re-reads the module-level subagent cache populated by setAvailableSubagents.
	const cachedBasePrompt = React.useMemo((): CachedPrompt | null => {
		if (!toolManager) return null;
		const availableNames = toolManager.getAvailableToolNames(
			tune,
			developmentMode,
			undefined,
			currentModel,
		);
		const baseBlocks = buildSystemPromptBlocks(
			developmentMode,
			tune,
			availableNames,
			toolsDisabled,
			getAppConfig().systemPrompt,
			currentModel,
		);
		const skillsBlock = buildSkillsPromptBlock();
		if (skillsBlock) baseBlocks.push(skillsBlock);
		const mcpBlock = buildMCPInstructionsBlock(toolManager);
		if (mcpBlock) baseBlocks.push(mcpBlock);
		const basePrompt = promptFromBlocks(baseBlocks);

		const tools = toolsDisabled
			? toolManager.getFilteredTools(availableNames)
			: {};
		const prompt = appendToolDefinitionsToPrompt(
			basePrompt,
			toolsDisabled,
			fallbackToolFormat,
			tools,
		);

		// XML/JSON fallback tool definitions historically append to the very end
		// of the system prompt. Preserve that exact order. Because that places
		// stable tool schemas after volatile blocks (cwd/date/AGENTS.md), we send
		// fallback prompts as one volatile block rather than placing an unsafe
		// cache breakpoint across per-turn data.
		const blocks =
			prompt === basePrompt
				? baseBlocks
				: [{text: prompt, cacheScope: 'volatile' as const}];

		// Update the cached prompt so /usage and context % see the full prompt
		setLastBuiltPrompt(prompt);

		return {prompt, blocks};
	}, [
		developmentMode,
		tune,
		toolManager,
		toolsDisabled,
		fallbackToolFormat,
		subagentsReady,
		currentModel,
	]);

	// Track when the current conversation started for elapsed time display
	const conversationStartTimeRef = React.useRef<number>(Date.now());

	// Memoize CommandIntegration to avoid recreating on every message
	const commandIntegration = React.useMemo(() => {
		if (!toolManager || !customCommandLoader) return null;
		return new CommandIntegration(customCommandLoader, toolManager);
	}, [toolManager, customCommandLoader]);

	// State for streaming message content
	const [streamingContent, setStreamingContent] = React.useState<string>('');
	const [isGenerating, setIsGenerating] = React.useState<boolean>(false);
	const [streamingReasoning, setStreamingReasoning] =
		React.useState<string>('');
	const [tokenCount, setTokenCount] = React.useState<number>(0);

	// Helper to reset all streaming state
	const resetStreamingState = React.useCallback(
		createResetStreamingState(
			setIsCancelling,
			setAbortController,
			setIsGenerating,
			setStreamingContent,
			setStreamingReasoning,
			setTokenCount,
		),
		[], // Setters are stable and don't need to be in dependencies
	);

	// Helper to display errors in chat queue
	const displayError = React.useCallback(
		(error: unknown, keyPrefix: string) => {
			displayErrorHelper(error, keyPrefix, addToChatQueue);
		},
		[addToChatQueue],
	);

	// Reset conversation state when messages are cleared
	React.useEffect(() => {
		if (messages.length === 0) {
			conversationStateManager.current.reset();
			if (privacySessionMapRef) {
				privacySessionMapRef.current = {};
			}
		}
	}, [messages.length, privacySessionMapRef]);

	// Wrapper for processAssistantResponse that includes error handling
	const processAssistantResponseWithErrorHandling = React.useCallback(
		async (systemMessage: Message, msgs: Message[]) => {
			if (!client) return;

			try {
				await processAssistantResponse({
					systemMessage,
					messages: msgs,
					client,
					toolManager,
					abortController,
					setAbortController,
					setIsGenerating,
					setStreamingReasoning,
					setStreamingContent,
					setTokenCount,
					setMessages,
					addToChatQueue,
					currentProvider,
					currentModel,
					developmentMode,
					developmentModeRef,
					nonInteractiveMode,
					conversationStateManager,
					onConversationComplete,
					conversationStartTime: conversationStartTimeRef.current,
					reasoningExpandedRef,
					iconThemeRef,
					compactToolDisplayRef,
					onSetCompactToolCounts,
					compactToolCountsRef,
					onSetLiveTaskList,
					setLiveComponent,
					setLastApiUsage,
					onApiCallComplete,
					tune,
					privacySessionMapRef,
					privacyEnabled,
					onPrivacyEvent: (count: number) => {
						// `count` is the number of NEW identifiers scrubbed on this turn
						// (the per-turn delta), not a session running total.
						addToChatQueue(
							infoMsg(
								`Privacy active: scrubbed ${count} new identifier${count === 1 ? '' : 's'}`,
								'privacy',
							),
						);
					},
				});
			} catch (error) {
				displayError(error, 'chat-error');
				// Signal completion on error to avoid hanging in non-interactive mode
				onConversationComplete?.();
			} finally {
				resetStreamingState();
			}
		},
		[
			client,
			toolManager,
			abortController,
			setAbortController,
			setMessages,
			addToChatQueue,
			currentProvider,
			currentModel,
			developmentMode,
			developmentModeRef,
			nonInteractiveMode,
			onConversationComplete,
			reasoningExpandedRef,
			iconThemeRef,
			compactToolDisplayRef,
			compactToolCountsRef,
			onSetCompactToolCounts,
			onSetLiveTaskList,
			tune,
			displayError,
			resetStreamingState,
			setLiveComponent,
			setLastApiUsage,
			onApiCallComplete,
			privacySessionMapRef,
			privacyEnabled,
		],
	);

	// Handle chat message processing
	const handleChatMessage = async (
		message: string,
		displayValue?: string,
		images?: ImageAttachment[],
	) => {
		if (!client || !toolManager) return;

		// Record conversation start time for elapsed time display
		conversationStartTimeRef.current = Date.now();

		// The submit chain hands us the display version (with [@file]
		// placeholders) alongside the fully assembled message. Use it directly
		// for the bubble; fall back to the raw message for callers that have no
		// placeholder view (custom commands, VS Code prompts).
		const displayMessage = displayValue ?? message;

		// Add user message to chat using display version (with placeholders)
		// Pass the full assembled message for accurate token counting
		addToChatQueue(
			<UserMessage
				key={generateKey('user')}
				message={displayMessage}
				tokenContent={message}
				imageCount={images?.length ?? 0}
			/>,
		);

		// Add user message to conversation history (single addition)
		const builder = new MessageBuilder(messages);
		builder.addUserMessage(message, images);
		const updatedMessages = builder.build();
		setMessages(updatedMessages);

		// Initialize conversation state if this is a new conversation
		if (messages.length === 0) {
			conversationStateManager.current.initializeState(message);
		}

		// Create abort controller for cancellation
		const controller = new AbortController();
		setAbortController(controller);

		try {
			const systemState = getBaseSystemPromptState(
				developmentMode,
				cachedBasePrompt,
				toolManager,
				tune,
				toolsDisabled,
				currentModel,
			);
			let systemPrompt = systemState.prompt;
			const systemBlocks = [...systemState.blocks];

			// Enhance with relevant commands (progressive disclosure). These
			// command/skill snippets are request-specific, so if they append content
			// to the prompt they become a trailing volatile block and never carry a
			// cache breakpoint.
			if (commandIntegration) {
				const enhanced = commandIntegration.enhanceSystemPrompt(
					systemPrompt,
					message,
				);
				if (enhanced !== systemPrompt) {
					const appended = enhanced
						.slice(systemPrompt.length)
						.replace(/^\n+/, '');
					if (appended.length > 0) {
						systemBlocks.push({text: appended, cacheScope: 'volatile'});
					}
					systemPrompt = enhanced;
				}
			}

			// Create stream request
			const systemMessage: Message = {
				role: 'system',
				content: systemPrompt,
				systemBlocks,
			};

			// Use the conversation loop
			await processAssistantResponseWithErrorHandling(
				systemMessage,
				updatedMessages,
			);

			// If this turn STARTED in plan mode (closure value, captured at submit
			// time) and ran to completion without being interrupted, a plan was
			// actually produced — signal the plan review bar. Deciding here, with
			// the start mode and the abort signal both in hand, avoids the race
			// where toggling modes mid-generation makes an unrelated completing turn
			// look like a finished plan.
			if (developmentMode === 'plan' && !controller.signal.aborted) {
				onPlanTurnComplete?.();
			}
		} catch (error) {
			displayError(error, 'chat-error');
			onConversationComplete?.();
		} finally {
			resetStreamingState();
		}
	};

	return {
		handleChatMessage,
		processAssistantResponse: processAssistantResponseWithErrorHandling,
		isGenerating,
		streamingReasoning,
		streamingContent,
		tokenCount,
	};
}
