import type {LanguageModel, SystemModelMessage} from 'ai';
import {
	InvalidToolInputError,
	NoSuchToolError,
	stepCountIs,
	streamText,
	ToolCallRepairError,
} from 'ai';
import {
	MAX_STREAM_DURATION_MS,
	MAX_STREAM_OUTPUT_CHARS,
	MAX_STREAM_STALL_RETRIES,
	MAX_TOOL_STEPS,
} from '@/constants';
import {formatForProvider, remapToolKeys} from '@/tools/tool-aliases';
import type {
	AIProviderConfig,
	AISDKCoreTool,
	LLMChatResponse,
	Message,
	ModeOverrides,
	ProviderKind,
	StreamCallbacks,
	ToolCall,
} from '@/types/index';
import {
	generateCorrelationId,
	getCorrelationId,
	getLogger,
	withNewCorrelationContext,
} from '@/utils/logging';
import {
	endMetrics,
	formatMemoryUsage,
	startMetrics,
} from '@/utils/logging/performance.js';
import {getSafeMemory} from '@/utils/logging/safe-process.js';
import {convertToModelMessages} from '../converters/message-converter.js';
import {convertAISDKToolCalls} from '../converters/tool-converter.js';
import {extractRootError} from '../error-handling/error-extractor.js';
import {parseAPIError} from '../error-handling/error-parser.js';
import {StreamRunawayError} from '../error-handling/stream-runaway-error.js';
import {isStreamStallError} from '../error-handling/stream-stall-detector.js';
import {isToolSupportError} from '../error-handling/tool-error-detector.js';
import {
	applyCachePolicy,
	providerSupportsCaching,
	type SystemPromptBlock,
} from '../prompt-caching.js';
import {buildProviderOptions} from './provider-options.js';
import {
	applyHeaderTransforms,
	applyParamsTransforms,
	applySystemTransforms,
} from './request-transforms.js';
import {
	createOnStepFinishHandler,
	createPrepareStepHandler,
} from './streaming-handler.js';
import {filterActiveToolsForTurn} from './tool-filter.js';

type SDKProviderOptions = Parameters<typeof streamText>[0]['providerOptions'];

function withLooseToolSchemas(
	tools: Record<string, AISDKCoreTool>,
	providerKind?: ProviderKind,
): Record<string, AISDKCoreTool> {
	if (providerKind !== 'chatgpt-codex' && providerKind !== 'github-copilot') {
		return tools;
	}
	return Object.fromEntries(
		Object.entries(tools).map(([name, toolDef]) => [
			name,
			{...toolDef, strict: false},
		]),
	) as Record<string, AISDKCoreTool>;
}

type StreamGuard = {
	maxOutputChars: number;
	maxDurationMs: number;
	disabled: boolean;
};

/** Runaway-stream bounds: provider override, else the generous global defaults. */
function resolveStreamGuard(providerConfig: AIProviderConfig): StreamGuard {
	const cfg = providerConfig.streamGuard;
	return {
		maxOutputChars: cfg?.maxOutputChars ?? MAX_STREAM_OUTPUT_CHARS,
		maxDurationMs: cfg?.maxDurationMs ?? MAX_STREAM_DURATION_MS,
		disabled: cfg?.disabled ?? false,
	};
}

export interface ChatHandlerParams {
	model: LanguageModel;
	currentModel: string;
	providerConfig: AIProviderConfig;
	/**
	 * Active provider kind, used to decide whether prompt-caching markers
	 * apply and how to shape them. When omitted, caching is disabled (legacy
	 * callers that haven't been wired through `AISDKClient.getProviderKind()`).
	 */
	providerKind?: ProviderKind;
	/**
	 * Stable per-session id forwarded to OpenAI/Codex Responses as
	 * `promptCacheKey` so the provider can route to a cache-warm region. Also
	 * sent as `x-session-affinity` / `X-Session-Id` headers (see AISDKClient).
	 */
	sessionAffinityId?: string;
	messages: Message[];
	tools: Record<string, AISDKCoreTool>;
	callbacks: StreamCallbacks;
	signal?: AbortSignal;
	maxRetries: number;
	skipTools?: boolean;
	/** How many times this turn has already been retried after a mid-stream stall. */
	stallRetryAttempt?: number;
	modeOverrides?: ModeOverrides;
	privacySessionMapRef?: React.MutableRefObject<Record<string, string>>;
	privacyEnabled?: boolean;
	onPrivacyEvent?: (scrubbedDelta: number) => void;
}

/**
 * Main chat handler - orchestrates the entire chat flow
 */
export async function handleChat(
	params: ChatHandlerParams,
): Promise<LLMChatResponse> {
	const {
		model,
		currentModel,
		providerConfig,
		providerKind,
		sessionAffinityId,
		messages,
		tools,
		callbacks,
		signal,
		maxRetries,
		skipTools = false,
		modeOverrides,
		privacySessionMapRef,
		privacyEnabled,
		onPrivacyEvent,
	} = params;
	const logger = getLogger();

	// Check if already aborted before starting
	if (signal?.aborted) {
		logger.debug('Chat request already aborted');
		throw new Error('Operation was cancelled');
	}

	// Check if tools should be disabled
	const shouldDisableTools =
		skipTools ||
		providerConfig.disableTools ||
		(providerConfig.disableToolModels &&
			providerConfig.disableToolModels.includes(currentModel));

	// Start performance tracking
	const metrics = startMetrics();
	const correlationId = getCorrelationId() || generateCorrelationId();

	if (shouldDisableTools) {
		logger.info('Tools disabled for request', {
			model: currentModel,
			reason: skipTools
				? 'retry without tools'
				: providerConfig.disableTools
					? 'provider configuration'
					: 'model configuration',
			correlationId,
		});
	}

	logger.info('Chat request starting', {
		model: currentModel,
		messageCount: messages.length,
		toolCount: shouldDisableTools ? 0 : Object.keys(tools).length,
		correlationId,
		provider: providerConfig.name,
	});

	// Accumulate reasoning text outside the try so the catch handler can
	// include it on the empty-response branch — the conversation loop's
	// reasoning-aware nudge depends on this for the GPT-5 case where the
	// SDK throws AI_NoOutputGeneratedError after a reasoning-only stream.
	let accumulatedReasoning = '';
	let accumulatedText = '';

	// Hoisted outside the try so the catch handler can inspect errors the SDK
	// reported via streamText's onError callback. A connectivity failure is
	// surfaced here AND then re-thrown by the SDK as AI_NoOutputGeneratedError
	// with no `cause`; without consulting this array the catch can't tell a
	// network failure apart from a genuine empty model turn.
	const streamingErrors: Error[] = [];

	return await withNewCorrelationContext(async _context => {
		try {
			// Tools arrive with approval policy already resolved by ToolManager.
			// No approval mutation needed here — chat handler is a pure SDK caller.
			const filteredTools = filterActiveToolsForTurn(tools, messages);
			const requestTools = withLooseToolSchemas(filteredTools, providerKind);
			const aiTools = shouldDisableTools
				? undefined
				: Object.keys(requestTools).length > 0
					? requestTools
					: undefined;

			// XML tool definitions are already included in the system prompt
			// when native tools are disabled (handled upstream in useChatHandler).

			// AI SDK v6 wants the system prompt via the top-level `system` option
			// rather than as a system-role entry in `messages` (it warns otherwise
			// to discourage prompt-injection-prone patterns). Extract it here.
			//
			// The system message may carry `systemBlocks` (structured stable/volatile
			// blocks produced by `buildSystemPromptBlocks`). When present, we preserve
			// the block structure so the prompt-caching layer can stamp a cache
			// breakpoint on the last STABLE block only — keeping per-turn changes
			// (cwd, date, AGENTS.md) from busting the cached stable prefix. When
			// absent, we fall back to the legacy joined-string behavior.
			const systemMessages = messages.filter(m => m.role === 'system');
			const nonSystemMessages = messages.filter(m => m.role !== 'system');

			let systemBlocks: SystemPromptBlock[] | undefined;
			let systemContent: string;
			const firstBlockCarrier = systemMessages.find(m => m.systemBlocks);
			if (
				firstBlockCarrier?.systemBlocks &&
				firstBlockCarrier.systemBlocks.length > 0
			) {
				systemBlocks = firstBlockCarrier.systemBlocks.map(b => ({...b}));
				systemContent = systemBlocks.map(b => b.text).join('\n\n');
			} else {
				systemContent = systemMessages.map(m => m.content).join('\n\n');
			}

			// Scrub prompts if privacy scrubbing is enabled
			let finalSystemContent = systemContent;
			let finalSystemBlocks = systemBlocks;
			let finalNonSystemMessages = nonSystemMessages;
			if (privacyEnabled && privacySessionMapRef) {
				const {scrub} = await import('@nanocollective/prompt-scrub');

				const prevCount = Object.keys(privacySessionMapRef.current).length;

				const scrubText = (text: string): string =>
					scrub({
						content: text,
						sessionMap: privacySessionMapRef.current,
						options: {disabledDetectors: ['PathDetector', 'UrlDetector']},
					}).scrubbedContent as string;

				finalSystemContent = scrubText(systemContent);
				if (finalSystemBlocks) {
					finalSystemBlocks = finalSystemBlocks.map(b => ({
						...b,
						text: scrubText(b.text),
					}));
				}

				finalNonSystemMessages = nonSystemMessages.map(m => {
					if (m.role === 'tool') return m;
					return {
						...m,
						content: scrubText(m.content),
					};
				});

				const newCount = Object.keys(privacySessionMapRef.current).length;
				const delta = newCount - prevCount;
				if (delta > 0 && onPrivacyEvent) {
					onPrivacyEvent(delta);
				}
			}

			// Convert messages to AI SDK ModelMessage format
			let modelMessages = convertToModelMessages(finalNonSystemMessages);

			// Run the cache-policy pass. For Anthropic-format providers this
			// stamps breakpoints across tools → system → latest user message in
			// invalidation order, sharing a single 4-breakpoint budget. For
			// other providers (OpenAI-format etc.) it's a no-op — their caching
			// is driven by `promptCacheKey` in buildProviderOptions instead.
			// (opencode `cache-policy.ts` parity.)
			const cacheResult = applyCachePolicy(
				finalSystemBlocks,
				modelMessages,
				aiTools ?? undefined,
				providerKind ?? 'openai-compatible',
			);
			modelMessages = cacheResult.messages;
			// Remap tool keys from canonical names to the model-facing names for
			// this provider's format (Bash/Read/Edit for Anthropic, apply_patch
			// for Codex, execute_bash/read_file for local). Incoming tool calls
			// are resolved back to canonical in convertAISDKToolCall.
			const format = formatForProvider(providerKind);
			const stampedTools = cacheResult.tools
				? (remapToolKeys(cacheResult.tools, format) as Record<
						string,
						AISDKCoreTool
					>)
				: cacheResult.tools;
			if (cacheResult.dropped > 0) {
				logger.warn(
					`Prompt cache: dropped ${cacheResult.dropped} breakpoint(s); Anthropic allows at most 4 per request.`,
					{provider: providerConfig.name, model: currentModel},
				);
			}

			// systemParam prefers the structured cached form when available;
			// otherwise falls back to the joined string (the SDK accepts both).
			let systemParam: string | SystemModelMessage[] | undefined =
				cacheResult.system ?? finalSystemContent ?? undefined;

			const transformContext = {
				providerConfig,
				providerKind,
				model: currentModel,
				messages: modelMessages,
				tools: stampedTools ?? aiTools,
			};
			systemParam = applySystemTransforms(systemParam, transformContext);

			logger.debug('AI SDK request prepared', {
				messageCount: modelMessages.length,
				hasSystem: systemContent.length > 0,
				hasTools: !!aiTools,
				toolCount: aiTools ? Object.keys(aiTools).length : 0,
				promptCaching:
					providerKind && providerSupportsCaching(providerKind)
						? `enabled (${providerKind}, ${cacheResult.dropped} dropped)`
						: 'disabled',
			});

			// These tools have `execute` stripped, so the SDK never auto-runs
			// them - it emits the tool call and stops, and our loop decides
			// approval/execution (see resolveToolApproval).
			// stopWhen controls when the tool loop stops (max MAX_TOOL_STEPS steps)

			// Provider-specific request extras (Codex Responses API fields,
			// OpenRouter provider routing / reasoning / transforms / fallback
			// models). buildProviderOptions returns undefined when nothing
			// applies, so the SDK call site doesn't see an empty object.
			let providerOptions = buildProviderOptions(
				providerConfig,
				systemContent,
				modeOverrides?.modelParameters,
				sessionAffinityId,
			);
			providerOptions = applyParamsTransforms(
				providerOptions,
				transformContext,
			);
			const requestHeaders = applyHeaderTransforms(
				providerConfig.config.headers,
				transformContext,
			);

			// Local abort controller chained to the caller's signal so the runaway
			// guard (in the loop below) can physically close the stream. AI SDK v6
			// abort is graceful — it emits an 'abort' chunk rather than throwing —
			// so we own the teardown here.
			const streamController = new AbortController();
			if (signal) {
				if (signal.aborted) {
					streamController.abort(signal.reason);
				} else {
					signal.addEventListener(
						'abort',
						() => streamController.abort(signal.reason),
						{once: true},
					);
				}
			}
			const streamStartMs = Date.now();
			const streamGuard = resolveStreamGuard(providerConfig);

			const result = streamText({
				model,
				...(systemParam ? {system: systemParam} : {}),
				messages: modelMessages,
				tools: stampedTools ?? aiTools,
				abortSignal: streamController.signal,
				maxRetries,
				stopWhen: stepCountIs(MAX_TOOL_STEPS),
				// Repair common weak-model tool-call mistakes before failing the turn.
				// The safe repair is case normalization only: if `Read_File` maps to an
				// existing `read_file`, retry with the real name. Anything more creative
				// risks executing a different tool than the model intended, so we return
				// null and let the existing NoSuchTool/InvalidToolInput handlers surface
				// the validation error for self-correction.
				experimental_repairToolCall: async failed => {
					const lower = failed.toolCall.toolName.toLowerCase();
					if (lower !== failed.toolCall.toolName && tools[lower]) {
						logger.debug('Repairing tool call name case', {
							from: failed.toolCall.toolName,
							to: lower,
							model: currentModel,
							provider: providerConfig.name,
						});
						return {
							...failed.toolCall,
							toolName: lower,
						};
					}
					return null;
				},
				onStepFinish: createOnStepFinishHandler(callbacks),
				prepareStep: createPrepareStepHandler(),
				onError: ({error}) => {
					// Collect streaming errors so raw SSE events don't leak to stdout.
					// AI SDK delivers plain objects here for some providers (e.g.
					// OpenRouter stream errors), so String() would yield "[object Object]".
					let e: Error;
					if (error instanceof Error) {
						e = error;
					} else if (typeof error === 'string') {
						e = new Error(error);
					} else {
						try {
							e = new Error(JSON.stringify(error));
						} catch {
							e = new Error(String(error));
						}
					}
					streamingErrors.push(e);
					logger.warn('Streaming error received', {
						error: e.message,
						model: currentModel,
						correlationId,
						provider: providerConfig.name,
					});
				},
				headers: requestHeaders,
				// Cast to the SDK's narrower JSON-only type. The values built by
				// buildProviderOptions are all JSON-serialisable, but TypeScript
				// can't infer that through our looser internal shape.
				providerOptions: providerOptions as SDKProviderOptions,
				// Model parameters from /tune — passed directly to AI SDK
				...(modeOverrides?.modelParameters && {
					temperature: modeOverrides.modelParameters.temperature,
					topP: modeOverrides.modelParameters.topP,
					topK: modeOverrides.modelParameters.topK,
					maxTokens: modeOverrides.modelParameters.maxTokens,
					frequencyPenalty: modeOverrides.modelParameters.frequencyPenalty,
					presencePenalty: modeOverrides.modelParameters.presencePenalty,
					...(modeOverrides.modelParameters.stop && {
						stopSequences: modeOverrides.modelParameters.stop,
					}),
				}),
			});

			// Stream tokens to the UI in batched chunks to avoid excessive
			// React/Ink re-renders that cause terminal flickering.
			const FLUSH_INTERVAL_MS = 150;
			let tokenBuffer = '';
			let flushTimer: ReturnType<typeof setTimeout> | null = null;
			let isReasoning = false;

			const flushBuffer = () => {
				if (tokenBuffer) {
					if (isReasoning) {
						callbacks.onReasoningToken?.(tokenBuffer);
					} else {
						callbacks.onToken?.(tokenBuffer);
					}
					tokenBuffer = '';
				}
				flushTimer = null;
			};

			let lastYield = Date.now();
			for await (const chunk of result.fullStream) {
				// Belt-and-braces: a graceful-abort stream can keep yielding
				// already-buffered chunks after the socket closed — stop on the
				// caller's signal regardless of the SDK's own teardown timing.
				if (signal?.aborted) {
					if (flushTimer) clearTimeout(flushTimer);
					throw new Error('Operation was cancelled');
				}
				switch (chunk.type) {
					case 'reasoning-delta':
						accumulatedReasoning += chunk.text;
						tokenBuffer += chunk.text;
						if (!flushTimer) {
							flushTimer = setTimeout(flushBuffer, FLUSH_INTERVAL_MS);
						}
						break;
					case 'text-delta':
						accumulatedText += chunk.text;
						tokenBuffer += chunk.text;
						if (!flushTimer) {
							flushTimer = setTimeout(flushBuffer, FLUSH_INTERVAL_MS);
						}
						break;

					// Determine which stream to write tokens to
					case 'reasoning-start':
						isReasoning = true;
						break;
					case 'text-start':
						isReasoning = false;
						break;

					// Flush remaining tokens in given stream
					case 'text-end':
					case 'reasoning-end':
						if (flushTimer) {
							clearTimeout(flushTimer);
						}
						flushBuffer();
						isReasoning = false;
						break;

					// AI SDK v6 abort is graceful: it emits this chunk and closes the
					// stream WITHOUT throwing. Throw here so we skip the heavy
					// post-processing tail (Promise.all + privacy rehydration over the
					// whole buffer) and stop immediately.
					case 'abort':
						if (flushTimer) clearTimeout(flushTimer);
						throw new Error('Operation was cancelled');
				}

				// Runaway-stream guard: an unbounded generation loop (repetition /
				// endless reasoning) never triggers a provider-side stall, so cap it
				// here. Aborting the local controller physically closes the stream.
				if (!streamGuard.disabled) {
					const totalChars =
						accumulatedText.length + accumulatedReasoning.length;
					if (totalChars > streamGuard.maxOutputChars) {
						streamController.abort();
						if (flushTimer) clearTimeout(flushTimer);
						throw new StreamRunawayError(
							'output-size',
							`${Math.round(totalChars / 1000)}k chars`,
						);
					}
					if (Date.now() - streamStartMs > streamGuard.maxDurationMs) {
						streamController.abort();
						if (flushTimer) clearTimeout(flushTimer);
						throw new StreamRunawayError(
							'duration',
							`${Math.round((Date.now() - streamStartMs) / 1000)}s`,
						);
					}
				}

				// Periodically yield to the event loop so timers and Ink renders
				// can run during long streaming responses (e.g. subagent execution)
				const now = Date.now();
				if (now - lastYield >= 200) {
					lastYield = now;
					await new Promise<void>(resolve => setTimeout(resolve, 0));
				}
			}

			// Safety net: flush any tokens still buffered if the stream ended
			// without emitting a matching text-end / reasoning-end event.
			if (flushTimer) {
				clearTimeout(flushTimer);
			}
			flushBuffer();

			// After streaming completes, collect final results.
			// `result.usage` is the FINAL step's usage (not `totalUsage`, which
			// sums across steps): with stopWhen=stepCountIs(MAX_TOOL_STEPS) a
			// single chat() call may span multiple steps, and the final step's
			// input+output tokens reflect the actual context window occupancy.
			const [
				fullText,
				resolvedToolCalls,
				resolvedSteps,
				reasoning,
				finishReason,
				usage,
			] = await Promise.all([
				result.text,
				result.toolCalls,
				result.steps,
				result.reasoningText,
				result.finishReason,
				result.usage,
			]);

			logger.debug('AI SDK response received', {
				responseLength: fullText.length,
				reasoningLength: reasoning?.length ?? 0,
				hasToolCalls: resolvedToolCalls.length > 0,
				toolCallCount: resolvedToolCalls.length,
				stepCount: resolvedSteps.length,
				finishReason,
			});

			if (finishReason === 'error' && streamingErrors.length > 0) {
				throw streamingErrors[streamingErrors.length - 1];
			}

			// Without execute functions on tools, the SDK doesn't auto-execute anything.
			// All tool calls are returned for us to handle (parallel execution, confirmation, etc.).
			const toolCalls: ToolCall[] =
				resolvedToolCalls.length > 0
					? convertAISDKToolCalls(resolvedToolCalls)
					: [];

			const content = fullText || accumulatedText;

			let finalContent = content;
			let finalReasoning = reasoning;
			let finalToolCalls = toolCalls;

			if (privacyEnabled && privacySessionMapRef) {
				const {rehydrate} = await import('@nanocollective/prompt-scrub');

				if (finalContent) {
					const result = rehydrate({
						content: finalContent,
						sessionMap: privacySessionMapRef.current,
					});
					finalContent = result.content as string;
					if (result.warnings && result.warnings.length > 0) {
						logger.warn('Prompt-scrub rehydration warnings (content)', {
							warnings: result.warnings,
						});
					}
				}

				if (finalReasoning) {
					const result = rehydrate({
						content: finalReasoning,
						sessionMap: privacySessionMapRef.current,
					});
					finalReasoning = result.content as string;
					if (result.warnings && result.warnings.length > 0) {
						logger.warn('Prompt-scrub rehydration warnings (reasoning)', {
							warnings: result.warnings,
						});
					}
				}

				if (finalToolCalls.length > 0) {
					finalToolCalls = finalToolCalls.map(tc => {
						try {
							const argsStr = JSON.stringify(tc.function.arguments);
							const result = rehydrate({
								content: argsStr,
								sessionMap: privacySessionMapRef.current,
							});
							if (result.warnings && result.warnings.length > 0) {
								logger.warn('Prompt-scrub rehydration warnings (tool args)', {
									toolName: tc.function.name,
									warnings: result.warnings,
								});
							}
							return {
								...tc,
								function: {
									...tc.function,
									arguments: JSON.parse(result.content as string),
								},
							};
						} catch (e) {
							logger.error('Failed to rehydrate tool call', {
								toolName: tc.function.name,
								error: e,
							});
							return tc;
						}
					});
				}
			}

			// Calculate performance metrics
			const finalMetrics = endMetrics(metrics);

			logger.info('Chat request completed successfully', {
				model: currentModel,
				duration: `${finalMetrics.duration.toFixed(2)}ms`,
				responseLength: content.length,
				reasoningLength: reasoning?.length ?? 0,
				toolCallsFound: toolCalls.length,
				memoryDelta: formatMemoryUsage(
					finalMetrics.memoryUsage || getSafeMemory(),
				),
				correlationId,
				provider: providerConfig.name,
			});

			callbacks.onFinish?.();

			return {
				choices: [
					{
						message: {
							role: 'assistant',
							content: finalContent,
							tool_calls:
								finalToolCalls.length > 0 ? finalToolCalls : undefined,
							reasoning: finalReasoning,
						},
					},
				],
				toolsDisabled: shouldDisableTools,
				usage: {
					inputTokens: usage.inputTokens,
					outputTokens: usage.outputTokens,
					totalTokens: usage.totalTokens,
					// Surface cache metrics so callers (logs, /usage) can observe
					// cache hit ratio — the primary success metric for prompt
					// caching. The AI SDK exposes these under inputTokenDetails.
					cacheReadInputTokens:
						usage.inputTokenDetails?.cacheReadTokens ?? usage.cachedInputTokens,
					cacheWriteInputTokens: usage.inputTokenDetails?.cacheWriteTokens,
				},
			};
		} catch (error) {
			// Calculate performance metrics even for errors
			const finalMetrics = endMetrics(metrics);

			// Check if this was a user-initiated cancellation
			if (error instanceof Error && error.name === 'AbortError') {
				logger.info('Chat request cancelled by user', {
					model: currentModel,
					duration: `${finalMetrics.duration.toFixed(2)}ms`,
					correlationId,
					provider: providerConfig.name,
				});
				throw new Error('Operation was cancelled');
			}

			// A cancellation surfaced from the stream loop (graceful-abort chunk or
			// the caller's signal). Treat it like the AbortError above — surface, do
			// not retry.
			if (
				error instanceof Error &&
				error.message === 'Operation was cancelled'
			) {
				throw error;
			}

			// A runaway generation loop was stopped by the guard. It must NOT be
			// retried (re-issuing re-runs the same loop) and the stall-retry regexes
			// don't match it — surface immediately, before the retry branches.
			if (error instanceof StreamRunawayError) {
				logger.warn('Stream runaway stopped by guard', {
					reason: error.reason,
					detail: error.detail,
					model: currentModel,
					correlationId,
					provider: providerConfig.name,
				});
				throw new Error(
					`Model output exceeded the runaway limit (${error.detail}) and was stopped. Try a different model, or raise/disable the streamGuard for this provider.`,
				);
			}

			// Check if error indicates tool support issue and we haven't retried
			if (!skipTools && isToolSupportError(error)) {
				logger.warn('Tool support error detected, retrying without tools', {
					model: currentModel,
					error: error instanceof Error ? error.message : error,
					correlationId,
					provider: providerConfig.name,
				});

				// Retry without tools
				return await handleChat({
					...params,
					skipTools: true, // Mark that we're retrying
				});
			}

			// Retry a transient mid-stream stall — a slow/free model went quiet and
			// the provider's SSE inactivity window elapsed with nothing usable
			// produced. Re-issue the same turn (the AbortError check above already
			// let real cancellations through) up to MAX_STREAM_STALL_RETRIES before
			// the error surfaces, so a single hiccup no longer drops the whole turn.
			// A mid-stream stall surfaces as a generic `NoOutputGeneratedError`;
			// the real transport message is captured via `onError` in
			// `streamingErrors`, so consult both.
			const stallAttempt = params.stallRetryAttempt ?? 0;
			const isStall =
				isStreamStallError(error) || streamingErrors.some(isStreamStallError);
			if (isStall && stallAttempt < MAX_STREAM_STALL_RETRIES) {
				logger.warn('Stream stalled; retrying turn', {
					attempt: stallAttempt + 1,
					max: MAX_STREAM_STALL_RETRIES,
					model: currentModel,
					correlationId,
					provider: providerConfig.name,
				});
				return await handleChat({
					...params,
					stallRetryAttempt: stallAttempt + 1,
				});
			}

			// Handle tool-specific errors - NoSuchToolError
			if (error instanceof NoSuchToolError) {
				logger.error('Tool not found', {
					toolName: error.toolName,
					model: currentModel,
					correlationId,
					provider: providerConfig.name,
				});

				// Provide helpful error message with available tools
				const availableTools = Object.keys(tools).join(', ');
				const errorMessage = availableTools
					? `Tool "${error.toolName}" does not exist. Available tools: ${availableTools}`
					: `Tool "${error.toolName}" does not exist and no tools are currently loaded.`;

				throw new Error(errorMessage);
			}

			// Handle tool-specific errors - InvalidToolInputError
			if (error instanceof InvalidToolInputError) {
				logger.error('Invalid tool input', {
					toolName: error.toolName,
					model: currentModel,
					correlationId,
					provider: providerConfig.name,
					validationError: error.message,
				});

				// Provide clear validation error
				throw new Error(
					`Invalid arguments for tool "${error.toolName}": ${error.message}`,
				);
			}

			// Handle tool-specific errors - ToolCallRepairError
			if (error instanceof ToolCallRepairError) {
				logger.error('Tool call repair failed', {
					toolName: error.originalError.toolName,
					model: currentModel,
					correlationId,
					provider: providerConfig.name,
					repairError: error.message,
				});

				// Fall through to general error handling
				// Don't throw here - let the general handler provide context
			}

			// Log the error with performance metrics
			logger.error('Chat request failed', {
				model: currentModel,
				duration: `${finalMetrics.duration.toFixed(2)}ms`,
				error: error instanceof Error ? error.message : error,
				errorName: error instanceof Error ? error.name : 'Unknown',
				errorType: error?.constructor?.name || 'Unknown',
				errorProps:
					error instanceof Error
						? Object.fromEntries(
								Object.getOwnPropertyNames(error)
									.filter(k => k !== 'stack')
									// biome-ignore lint/suspicious/noExplicitAny: dynamic error shape
									.map(k => [k, (error as any)[k]]),
							)
						: undefined,
				correlationId,
				provider: providerConfig.name,
				memoryDelta: formatMemoryUsage(
					finalMetrics.memoryUsage || getSafeMemory(),
				),
			});

			// AI SDK wraps errors in NoOutputGeneratedError with no useful cause
			// Check if it's a cancellation without an underlying API error
			if (
				error instanceof Error &&
				(error.name === 'AI_NoOutputGeneratedError' ||
					error.message.includes('No output generated'))
			) {
				// Check if there's an underlying RetryError with the real cause
				const rootError = extractRootError(error);
				if (rootError === error) {
					// No underlying error - check if user actually cancelled
					if (signal?.aborted) {
						throw new Error('Operation was cancelled');
					}
					// The SDK frequently re-throws transport failures (no internet,
					// DNS/connection errors) as AI_NoOutputGeneratedError WITHOUT a
					// `cause`, so extractRootError can't recover them. But streamText's
					// onError callback already captured the real error here. Surface it
					// instead of returning an empty turn, otherwise the conversation
					// loop mistakes the network failure for context exhaustion and
					// prints a misleading "Context too large" auto-compact message.
					if (streamingErrors.length > 0) {
						const userMessage = parseAPIError(
							streamingErrors[streamingErrors.length - 1],
						);
						throw new Error(userMessage);
					}
					// Model returned no output without an underlying API error.
					// Hand control back to the conversation loop with an empty
					// response so its empty-turn handling (capped recursion,
					// reasoning-aware nudge) takes over instead of throwing.
					logger.warn(
						'Model produced no output; returning streamed fallback response',
						{
							model: currentModel,
							correlationId,
							provider: providerConfig.name,
							responseLength: accumulatedText.length,
							reasoningLength: accumulatedReasoning.length,
						},
					);
					callbacks.onFinish?.();
					return {
						choices: [
							{
								message: {
									role: 'assistant',
									content: accumulatedText,
									reasoning: accumulatedReasoning || undefined,
								},
							},
						],
						toolsDisabled: shouldDisableTools,
					};
				}
				// There's a real error underneath, parse it
				const userMessage = parseAPIError(rootError);
				throw new Error(userMessage);
			}

			// Parse any other error (including RetryError and APICallError)
			const userMessage = parseAPIError(error);
			throw new Error(userMessage);
		}
	}, correlationId); // End of withNewCorrelationContext
}
