import {Box, Text} from 'ink';
import React from 'react';
import {appendToolDefinitionsToPrompt} from '@/ai-sdk-client/tools/system-prompt-assembler';
import {ConversationStateManager} from '@/app/utils/conversation-state';
import AssistantMessage from '@/components/assistant-message';
import AssistantReasoning from '@/components/assistant-reasoning';
import UserMessage from '@/components/user-message';
import {getAppConfig} from '@/config/index';
import {
	getInnerDaemonModel,
	getSteeringEnabled,
	getSteeringVerbose,
	subscribeSteeringPrefs,
} from '@/config/preferences';
import {CommandIntegration} from '@/custom-commands/command-integration';
import {useTheme} from '@/hooks/useTheme';
import {generateKey} from '@/session/key-generator';
import {formatAvailableSkillsForPrompt} from '@/skills/prompt';
import {
	createInnerDaemonExecutor,
	loadAndCreateSteeringEngine,
} from '@/steering';
import type {SteeringEngine} from '@/steering/steering-engine';
import {getTuneToolMode} from '@/types/config';
import type {ImageAttachment, Message} from '@/types/core';
import {MessageBuilder} from '@/utils/message-builder';
import {
	type BuiltPromptBlock,
	buildSystemPromptBlocks,
	setLastBuiltPrompt,
} from '@/utils/prompt-builder';
import {
	flushPendingActivityToStatic,
	processAssistantResponse,
} from './conversation/conversation-loop';
import {createResetStreamingState} from './state/streaming-state';
import type {ChatHandlerReturn, UseChatHandlerProps} from './types';
import {displayError as displayErrorHelper} from './utils/message-helpers';

type CachedPrompt = {
	prompt: string;
	blocks: BuiltPromptBlock[];
};

function PrivacyNotice({message}: {message: string}) {
	const {colors} = useTheme();
	return (
		<Box marginBottom={1}>
			<Text color={colors.secondary}>{message}</Text>
		</Box>
	);
}

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
	addTransientNotice,
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

	// Auto-steering engine (InnerDaemon). Built once client + toolManager are
	// available; rules load from .nanocoder/steering/ (project) + the personal
	// config dir. Recreated only when the model or toolManager changes (a model
	// switch must update the engine's model gate). The InnerDaemon SubagentExecutor
	// is bound lazily on first evaluation to avoid constructing it eagerly on
	// every render (and to avoid a hard dependency on SubagentLoader being
	// initialized — InnerDaemon is a built-in, always-available subagent).
	const steeringEngineRef = React.useRef<SteeringEngine | null>(null);
	const innerdaemonBoundRef = React.useRef(false);
	// Reactive reads of the InnerDaemon preferences. useSyncExternalStore lets a
	// toggle from anywhere (the /innerdaemon command, the Settings dialog) rebuild
	// or tear down the engine both directions at runtime — the setters notify via
	// subscribeSteeringPrefs.
	const steeringEnabledPref = React.useSyncExternalStore(
		subscribeSteeringPrefs,
		getSteeringEnabled,
		getSteeringEnabled,
	);
	const steeringVerbosePref = React.useSyncExternalStore(
		subscribeSteeringPrefs,
		getSteeringVerbose,
		getSteeringVerbose,
	);
	// InnerDaemon's configured model (null = inherit the session model, the
	// default). A change notifies via subscribeSteeringPrefs; folding it into the
	// engine memo below re-binds the executor with a fresh model resolver.
	const innerDaemonModelPref = React.useSyncExternalStore(
		subscribeSteeringPrefs,
		getInnerDaemonModel,
		getInnerDaemonModel,
	);
	const steeringEngine = React.useMemo<SteeringEngine | null>(() => {
		// Disabled → engine is never built or run (the loop treats null as "skip
		// evaluation"): no InnerDaemon subagent calls, no blocks/nudges.
		if (!steeringEnabledPref || !client || !toolManager) {
			steeringEngineRef.current = null;
			return null;
		}
		const engine = loadAndCreateSteeringEngine(
			process.cwd(),
			currentModel,
			() => process.cwd(),
		);
		steeringEngineRef.current = engine;
		innerdaemonBoundRef.current = false; // re-bind after recreation
		return engine;
	}, [steeringEnabledPref, currentModel, client, toolManager]);

	// Lazy-bind the InnerDaemon executor the first time the engine is used. Kept
	// out of the memo so we don't construct a SubagentExecutor on every render.
	const ensureInnerdaemonBound = React.useCallback(() => {
		const engine = steeringEngineRef.current;
		if (!engine || innerdaemonBoundRef.current || !client || !toolManager)
			return;
		// Wire the live mode ref (same source the conversation loop reads) so
		// InnerDaemon's read-only probes follow the user's current mode. Without
		// it the executor snapshots 'normal' and its execute_bash checks pop a
		// spurious confirmation prompt even in yolo.
		const executor = createInnerDaemonExecutor(
			toolManager,
			client,
			developmentModeRef
				? () => developmentModeRef.current ?? 'normal'
				: undefined,
			// Live model resolver: read the InnerDaemon-model preference on every
			// run. null (default) → undefined → inherit the session model exactly
			// as before; a set value overrides it (see SubagentExecutor).
			() => getInnerDaemonModel() ?? undefined,
		);
		engine.bindExecutor(executor);
		innerdaemonBoundRef.current = true;
	}, [client, toolManager, developmentModeRef]);

	// A runtime change to the InnerDaemon model (Settings) must re-bind the
	// executor so its model resolver is re-applied. The resolver reads the pref
	// live, but forcing a re-bind keeps the wiring explicit and matches the
	// enabled/verbose reactive pattern. Skips the initial mount (nothing bound
	// yet) — ensureInnerdaemonBound binds lazily on first evaluation.
	// biome-ignore lint/correctness/useExhaustiveDependencies: innerDaemonModelPref is the trigger; the ref reset is the whole effect.
	React.useEffect(() => {
		innerdaemonBoundRef.current = false;
	}, [innerDaemonModelPref]);

	// Keep the engine's model id in sync with the active model (the memo above
	// recreates the whole engine on model change, but this covers the case where
	// the engine is reused and only the model string differs).
	React.useEffect(() => {
		if (steeringEngineRef.current) {
			steeringEngineRef.current.setModelId(currentModel);
		}
	}, [currentModel]);

	// The slash command the user invoked for the current conversation loop, if
	// any (e.g. 'worktree'). Detected in handleChatMessage and read by the
	// conversation loop via the userTriggeredSkill param so steering rules keyed
	// on `userTriggeredSkill` can fire.
	const userTriggeredSkillRef = React.useRef<string | undefined>(undefined);

	// State for streaming message content
	const [streamingContent, setStreamingContent] = React.useState<string>('');
	const [isGenerating, setIsGenerating] = React.useState<boolean>(false);
	const [streamingReasoning, setStreamingReasoning] =
		React.useState<string>('');
	const [tokenCount, setTokenCount] = React.useState<number>(0);

	// Mirror the in-flight streamed text/reasoning so the interrupt/error path
	// can commit the uncommitted partial to the static transcript. The
	// conversation loop clears these to '' right before it commits a completed
	// turn, so at abort-throw time the refs hold exactly the text that was
	// visible in the live region but not yet in scrollback.
	const streamedContentRef = React.useRef('');
	const streamedReasoningRef = React.useRef('');
	const setStreamingContentTracked = React.useCallback((content: string) => {
		streamedContentRef.current = content;
		setStreamingContent(content);
	}, []);
	const setStreamingReasoningTracked = React.useCallback(
		(reasoning: string) => {
			streamedReasoningRef.current = reasoning;
			setStreamingReasoning(reasoning);
		},
		[],
	);

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
			displayErrorHelper(error, keyPrefix, addToChatQueue, addTransientNotice);
		},
		[addToChatQueue, addTransientNotice],
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

			// Bind the InnerDaemon executor lazily on first conversation (cheap no-op
			// after the first call). Disabled for non-interactive/headless runs to
			// avoid steering background automation.
			if (!nonInteractiveMode) {
				ensureInnerdaemonBound();
			}

			// Reset per-conversation steering fire state so a new user turn starts
			// with a clean escalation budget.
			steeringEngineRef.current?.resetFireState();

			// A previous turn's partials must never leak into this conversation's
			// interrupt handling (e.g. an immediate pre-stream failure).
			streamedContentRef.current = '';
			streamedReasoningRef.current = '';

			try {
				await processAssistantResponse({
					systemMessage,
					messages: msgs,
					client,
					toolManager,
					abortController,
					setAbortController,
					setIsGenerating,
					setStreamingReasoning: setStreamingReasoningTracked,
					setStreamingContent: setStreamingContentTracked,
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
						const message = `Privacy active: scrubbed ${count} new identifier${count === 1 ? '' : 's'}`;
						addToChatQueue(
							<PrivacyNotice key={generateKey('privacy')} message={message} />,
						);
					},
					// Auto-steering: pass the engine (null when disabled — subagents,
					// headless, or before client/toolManager are ready). turnFacts
					// starts empty for each new conversation loop and accumulates
					// inside processAssistantResponse as turns recur.
					steeringEngine: nonInteractiveMode ? null : steeringEngine,
					steeringVerbose: steeringVerbosePref,
					turnFacts: [],
					userTriggeredSkill: userTriggeredSkillRef.current,
				});
			} catch (error) {
				// The loop unwound exceptionally (Escape/interrupt or a mid-turn
				// error), skipping every natural flush point. Commit what the user
				// could already see in the live region — the grouped tool tally
				// (and any pending omnicode Thought run) plus the partially
				// streamed reasoning/text — to the static transcript BEFORE the
				// conversation-complete cleanup wipes it, so already-executed
				// steps collapse in place instead of vanishing.
				flushPendingActivityToStatic(
					addToChatQueue,
					compactToolCountsRef,
					onSetCompactToolCounts,
					compactToolDisplayRef,
				);
				if (streamedReasoningRef.current.trim()) {
					addToChatQueue(
						<AssistantReasoning
							key={generateKey('assistant-reasoning-interrupted')}
							reasoning={streamedReasoningRef.current}
							expand={reasoningExpandedRef?.current ?? false}
						/>,
					);
				}
				if (streamedContentRef.current.trim()) {
					addToChatQueue(
						<AssistantMessage
							key={generateKey('assistant-interrupted')}
							message={streamedContentRef.current}
							model={currentModel}
						/>,
					);
				}
				streamedReasoningRef.current = '';
				streamedContentRef.current = '';
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
			steeringEngine,
			steeringVerbosePref,
			ensureInnerdaemonBound,
			setStreamingContentTracked,
			setStreamingReasoningTracked,
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

		// Detect a leading slash command (e.g. '/worktree …') so steering rules
		// keyed on `userTriggeredSkill` can fire for this conversation loop.
		const commandMatch = /^\s*\/([a-zA-Z0-9:_-]+)/.exec(message);
		userTriggeredSkillRef.current = commandMatch ? commandMatch[1] : undefined;

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
