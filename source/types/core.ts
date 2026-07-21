import {
	type Tool as AISDKTool,
	asSchema,
	type JSONValue,
	jsonSchema,
	tool,
} from 'ai';
import React from 'react';
import type {AIProviderConfig} from '@/types/config';

export {asSchema, jsonSchema, tool};

// Type for AI SDK tools (return type of tool() function)
// Tool<PARAMETERS, RESULT> is AI SDK's actual tool type
// We use 'any' for generics since we don't auto-execute tools (human-in-the-loop)
// biome-ignore lint/suspicious/noExplicitAny: Dynamic typing required
export type AISDKCoreTool = AISDKTool<any, any>;

export type ToolApprovalPolicy =
	| boolean
	// biome-ignore lint/suspicious/noExplicitAny: tool args are schema-validated per tool
	| ((args: any, mode: DevelopmentMode) => boolean | Promise<boolean>);

export interface ImageAttachment {
	data: string;
	mediaType: string;
	source?: string;
}

export interface Message {
	role: 'user' | 'assistant' | 'system' | 'tool';
	content: string;
	tool_calls?: ToolCall[];
	tool_call_id?: string;
	name?: string;
	reasoning?: string;
	structuredContent?: JSONValue;
	images?: ImageAttachment[];
	/**
	 * Structured system-prompt blocks, each tagged with a cache scope. Only
	 * present on `role: 'system'` messages produced by the chat handler when
	 * prompt caching is active. When present, the AI SDK client uses these to
	 * emit the system prompt as multiple `SystemModelMessage` parts with a
	 * cache breakpoint on the last stable block; when absent, the system
	 * `content` string is used as a single block (legacy behavior).
	 */
	systemBlocks?: Array<{text: string; cacheScope: 'stable' | 'volatile'}>;
}

export interface ToolCall {
	id: string;
	function: {
		name: string;
		arguments: Record<string, unknown>;
	};
}

export interface ToolResult {
	tool_call_id: string;
	role: 'tool';
	name: string;
	content: string;
	structuredContent?: JSONValue;
	isError?: boolean;
}

export interface ToolParameterSchema {
	type?: string;
	description?: string;
	[key: string]: unknown;
}

export interface Tool {
	type: 'function';
	function: {
		name: string;
		description: string;
		parameters: {
			type: 'object';
			properties: Record<string, ToolParameterSchema>;
			required: string[];
		};
	};
}

export interface StructuredToolOutput {
	llmContent: string;
	structured: JSONValue;
}

export type ToolExecuteResult = string | StructuredToolOutput;

// biome-ignore lint/suspicious/noExplicitAny: Dynamic typing required -- Tool arguments are dynamically typed
export type ToolHandler = (input: any) => Promise<ToolExecuteResult>;

export type ToolFormatter = (
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic typing required -- Tool arguments are dynamically typed
	args: any,
	result?: string,
) =>
	| string
	| Promise<string>
	| React.ReactElement
	| Promise<React.ReactElement>;

export interface ValidationErrorDetail {
	path?: string;
	expected?: string;
	received?: string;
	message?: string;
}

export type ToolValidationResult =
	| {valid: true}
	| {valid: false; error: string; details?: ValidationErrorDetail[]};

export type ToolValidator = (
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic typing required -- Tool arguments are dynamically typed
	args: any,
) => Promise<ToolValidationResult>;

export type StreamingFormatter = (
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic typing required -- Tool arguments are dynamically typed
	args: any,
	executionId: string,
) => React.ReactElement;

export interface NanocoderToolExport {
	name: string;
	tool: AISDKCoreTool;
	formatter?: ToolFormatter;
	streamingFormatter?: StreamingFormatter;
	validator?: ToolValidator;
	readOnly?: boolean;
	approval?: ToolApprovalPolicy;
}

export interface ToolEntry {
	name: string;
	tool: AISDKCoreTool;
	handler: ToolHandler;
	formatter?: ToolFormatter;
	streamingFormatter?: StreamingFormatter;
	validator?: ToolValidator;
	readOnly?: boolean;
	approval?: ToolApprovalPolicy;
	ownerSkill?: string;
	scoped?: boolean;
}

interface LLMMessage {
	role: 'assistant';
	content: string;
	tool_calls?: ToolCall[];
	reasoning?: string;
}

export interface ApiUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	/**
	 * Input tokens served from the provider's prompt cache (not re-billed).
	 * Surface this in logs/UI so cache hit ratio is observable — it's the
	 * primary success metric for prompt-caching support.
	 */
	cacheReadInputTokens?: number;
	/**
	 * Input tokens written to the provider's prompt cache this turn (usually
	 * billed at a write premium). Non-zero only on the turn that establishes
	 * a cached prefix.
	 */
	cacheWriteInputTokens?: number;
}

export interface ApiUsageSnapshot extends ApiUsage {
	atMessageCount: number;
}

/**
 * Per-call usage record accumulated across a session. Each entry corresponds
 * to one API (model) invocation and carries the provider/model active at the
 * time, so the /usage command can compute accurate per-provider costs from
 * real provider-reported token counts rather than client-side estimates.
 */
export interface ApiCallRecord {
	provider: string;
	model: string;
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	cacheReadInputTokens?: number;
	cacheWriteInputTokens?: number;
	timestamp: number;
}

/**
 * Provenance of a displayed context figure:
 * - `api`: fully provider-reported (the snapshot covers the whole conversation,
 *   or the estimated tail is too small to move the rounded percentage).
 * - `api+estimate`: anchored on the provider-reported total, with a client-side
 *   estimate added for the messages appended since the snapshot.
 * - `estimate`: fully client-side (no usable API report yet).
 */
export type ContextSource = 'api' | 'api+estimate' | 'estimate';

export interface LLMChatResponse {
	choices: Array<{
		message: LLMMessage;
	}>;
	toolsDisabled?: boolean;
	usage?: ApiUsage;
}

export interface StreamCallbacks {
	onToken?: (token: string) => void;
	onReasoningToken?: (token: string) => void;
	onToolCall?: (toolCall: ToolCall) => void;
	onFinish?: () => void;
	onPrivacyEvent?: (scrubbedDelta: number) => void;
}

export interface ModeOverrides {
	nonInteractiveMode: boolean;
	nonInteractiveAlwaysAllow: string[];
	modelParameters?: import('@/types/config').ModelParameters;
	privacySessionMapRef?: import('react').MutableRefObject<
		Record<string, string>
	>;
	privacyEnabled?: boolean;
}

export interface LLMClient {
	getCurrentModel(): string;
	setModel(model: string): void;
	getContextSize(): number;
	getAvailableModels(): Promise<string[]>;
	getProviderConfig(): AIProviderConfig;
	/**
	 * The active provider kind. Used by the chat handler to decide whether
	 * prompt-caching markers apply and to shape provider-specific options.
	 * Implementations that don't track a structured provider kind should
	 * return `'openai-compatible'` as the safe default.
	 */
	getProviderKind?(): ProviderKind;
	chat(
		messages: Message[],
		tools: Record<string, AISDKCoreTool>,
		callbacks: StreamCallbacks,
		signal?: AbortSignal,
		modeOverrides?: ModeOverrides,
	): Promise<LLMChatResponse>;
	clearContext(): Promise<void>;
	getTimeout(): number | undefined;
}

/**
 * The discriminated provider kinds the AI SDK client can instantiate. Mirrors
 * `TaggedProvider['kind']` from `source/ai-sdk-client/providers/provider-factory.ts`
 * but redeclared here so `source/types/` doesn't import from the client layer
 * (which would create a circular dependency).
 */
export type ProviderKind =
	| 'anthropic'
	| 'openai-compatible'
	| 'github-copilot'
	| 'chatgpt-codex'
	| 'google';

export type DevelopmentMode =
	| 'normal'
	| 'auto-accept'
	| 'yolo'
	| 'plan'
	| 'headless';

export const DEVELOPMENT_MODE_LABELS: Record<DevelopmentMode, string> = {
	normal: '▶ normal mode on',
	'auto-accept': '⏵⏵ auto-accept mode on',
	yolo: '⏵⏵⏵ yolo mode on',
	plan: '⏸ plan mode on',
	headless: '⏵⏵ headless mode on',
};

export const DEVELOPMENT_MODE_LABELS_NARROW: Record<DevelopmentMode, string> = {
	normal: '▶ normal',
	'auto-accept': '⏵⏵ auto',
	yolo: '⏵⏵⏵ yolo',
	plan: '⏸ plan',
	headless: '⏵⏵ headless',
};

export type ConnectionStatus = 'connected' | 'failed' | 'pending';

export interface MCPConnectionStatus {
	name: string;
	status: ConnectionStatus;
	errorMessage?: string;
}

export interface LSPConnectionStatus {
	name: string;
	status: ConnectionStatus;
	errorMessage?: string;
}
