import type {LanguageModel} from 'ai';
import {randomUUID} from 'crypto';
import {Agent} from 'undici';
import {
	TIMEOUT_SOCKET_DEFAULT_MS,
	TIMEOUT_SOCKET_LOCAL_DEFAULT_MS,
} from '@/constants';
import {getModelContextLimit} from '@/models/index.js';
import type {
	AIProviderConfig,
	AISDKCoreTool,
	LLMChatResponse,
	LLMClient,
	Message,
	ModeOverrides,
	StreamCallbacks,
} from '@/types/index';
import {getLogger} from '@/utils/logging';
import {isLocalURL} from '@/utils/url-utils';
import {handleChat} from './chat/chat-handler.js';
import {
	createProvider,
	type TaggedProvider,
} from './providers/provider-factory.js';
import {getTlsConnectOptions} from './tls-config.js';

export class AISDKClient implements LLMClient {
	// Definite-assignment: populated by the async `create()` factory before
	// the client is handed to callers. The constructor only does sync setup.
	private provider!: TaggedProvider;
	private currentModel: string;
	private availableModels: string[];
	private providerConfig: AIProviderConfig;
	private undiciAgent: Agent;
	private cachedContextSize: number;
	private maxRetries: number;
	private sessionAffinityId: string;

	constructor(providerConfig: AIProviderConfig) {
		const logger = getLogger();

		this.providerConfig = providerConfig;
		this.availableModels = providerConfig.models;
		this.currentModel = providerConfig.models[0] || '';
		this.cachedContextSize = 0;
		this.sessionAffinityId = randomUUID();
		// Default to 2 retries (same as AI SDK default), or use configured value
		this.maxRetries = providerConfig.maxRetries ?? 2;

		logger.info('AI SDK client initializing', {
			models: this.availableModels,
			defaultModel: this.currentModel,
			provider: providerConfig.name || 'unknown',
			baseUrl: providerConfig.config.baseURL ? '[REDACTED]' : undefined,
			maxRetries: this.maxRetries,
		});

		const {connectionPool} = this.providerConfig;
		const {requestTimeout, socketTimeout} = this.providerConfig;
		const effectiveSocketTimeout = socketTimeout ?? requestTimeout;
		const isLocal =
			providerConfig.config.baseURL &&
			isLocalURL(providerConfig.config.baseURL);
		const defaultTimeout = isLocal
			? TIMEOUT_SOCKET_LOCAL_DEFAULT_MS
			: TIMEOUT_SOCKET_DEFAULT_MS;
		const resolvedSocketTimeout =
			effectiveSocketTimeout === -1
				? 0
				: (effectiveSocketTimeout ?? defaultTimeout);

		this.undiciAgent = new Agent({
			connect: {
				timeout: resolvedSocketTimeout,
				...getTlsConnectOptions(this.providerConfig),
			},
			bodyTimeout: resolvedSocketTimeout,
			headersTimeout: resolvedSocketTimeout,
			keepAliveTimeout: connectionPool?.idleTimeout,
			keepAliveMaxTimeout: connectionPool?.cumulativeMaxIdleTimeout,
		});

		// Fetch context size asynchronously (don't block construction)
		void this.updateContextSize();
	}

	/**
	 * Fetch and cache context size from models.dev
	 */
	private async updateContextSize(): Promise<void> {
		const logger = getLogger();
		try {
			const contextSize = await getModelContextLimit(this.currentModel, {
				providerConfig: this.providerConfig,
			});
			this.cachedContextSize = contextSize || 0;
		} catch (error) {
			logger.debug('Failed to get model context size', {
				model: this.currentModel,
				error,
			});
			this.cachedContextSize = 0;
		}
	}

	static async create(providerConfig: AIProviderConfig): Promise<AISDKClient> {
		const client = new AISDKClient(providerConfig);
		// Async provider creation — lazily loads only the SDK package the
		// configured `sdkProvider` actually needs.
		client.provider = await createProvider(
			client.providerConfig,
			client.undiciAgent,
		);
		return client;
	}

	setModel(model: string): void {
		const logger = getLogger();
		const previousModel = this.currentModel;

		this.currentModel = model;

		logger.info('Model changed', {
			previousModel,
			newModel: model,
			provider: this.providerConfig.name,
		});

		// Update context size when model changes
		void this.updateContextSize();
	}

	getCurrentModel(): string {
		return this.currentModel;
	}

	getProviderConfig(): AIProviderConfig {
		return this.providerConfig;
	}

	getContextSize(): number {
		return this.cachedContextSize;
	}

	getMaxRetries(): number {
		return this.maxRetries;
	}

	getAvailableModels(): Promise<string[]> {
		return Promise.resolve(this.availableModels);
	}

	/**
	 * Stream chat with real-time token updates
	 */
	async chat(
		messages: Message[],
		tools: Record<string, AISDKCoreTool>,
		callbacks: StreamCallbacks,
		signal?: AbortSignal,
		modeOverrides?: ModeOverrides,
	): Promise<LLMChatResponse> {
		const getModel = (modelName: string): LanguageModel => {
			// GitHub Copilot requires routing: GPT-5+ → Responses API, others → Chat Completions.
			// ChatGPT/Codex always uses the Responses API.
			switch (this.provider.kind) {
				case 'chatgpt-codex':
					return this.provider.provider.responses(modelName);
				case 'github-copilot':
					return modelName.includes('gpt-5')
						? this.provider.provider.responses(modelName)
						: this.provider.provider.chat(modelName);
				case 'openai-compatible':
				case 'anthropic':
				case 'google':
					return this.provider.provider(modelName) as LanguageModel;
			}
		};

		const sessionHeaders = {
			...this.providerConfig.config.headers,
			'x-session-affinity': this.sessionAffinityId,
			'X-Session-Id': this.sessionAffinityId,
		};
		const providerConfigForRequest: AIProviderConfig = {
			...this.providerConfig,
			config: {
				...this.providerConfig.config,
				headers: sessionHeaders,
			},
		};

		const runChat = async (modelName: string) =>
			await handleChat({
				model: getModel(modelName),
				currentModel: modelName,
				providerConfig: providerConfigForRequest,
				providerKind: this.provider.kind,
				sessionAffinityId: this.sessionAffinityId,
				messages,
				tools,
				callbacks,
				signal,
				maxRetries: this.maxRetries,
				modeOverrides,
				privacySessionMapRef: modeOverrides?.privacySessionMapRef,
				privacyEnabled: modeOverrides?.privacyEnabled,
				onPrivacyEvent: callbacks.onPrivacyEvent,
			});

		try {
			return await runChat(this.currentModel);
		} catch (error) {
			const fallbackModel = this.providerConfig.fallbackModel;
			const canFallback =
				fallbackModel &&
				fallbackModel !== this.currentModel &&
				this.availableModels.includes(fallbackModel) &&
				!(
					error instanceof Error && error.message === 'Operation was cancelled'
				);
			if (!canFallback) throw error;

			getLogger().warn(
				'Primary model failed; retrying once with fallback model',
				{
					provider: this.providerConfig.name,
					primaryModel: this.currentModel,
					fallbackModel,
					error: error instanceof Error ? error.message : String(error),
				},
			);
			return await runChat(fallbackModel);
		}
	}

	clearContext(): Promise<void> {
		const logger = getLogger();

		logger.debug('AI SDK client context cleared', {
			model: this.currentModel,
			provider: this.providerConfig.name,
		});

		// No internal state to clear
		return Promise.resolve();
	}

	getTimeout(): number | undefined {
		return (
			this.providerConfig.socketTimeout ?? this.providerConfig.requestTimeout
		);
	}

	/**
	 * The kind of the active provider (`'anthropic'`, `'openai-compatible'`,
	 * `'github-copilot'`, `'chatgpt-codex'`, `'google'`). Used by the chat
	 * handler to decide whether prompt-caching markers apply and to shape
	 * provider-specific options without re-deriving the kind from config.
	 */
	getProviderKind(): TaggedProvider['kind'] {
		return this.provider.kind;
	}
}
