import type {ModelMessage, SystemModelMessage} from 'ai';
import type {
	AIProviderConfig,
	AISDKCoreTool,
	ProviderKind,
} from '@/types/index';
import type {ProviderOptions} from './provider-options.js';

export type SystemParam = string | SystemModelMessage[] | undefined;

export interface ChatTransformContext {
	providerConfig: AIProviderConfig;
	providerKind?: ProviderKind;
	model: string;
	messages: ModelMessage[];
	tools?: Record<string, AISDKCoreTool>;
}

export interface ChatRequestTransform {
	/** Transform the final top-level `system` value before streamText(). */
	system?: (system: SystemParam, context: ChatTransformContext) => SystemParam;
	/** Transform provider-specific request body options before streamText(). */
	params?: (
		providerOptions: ProviderOptions | undefined,
		context: ChatTransformContext,
	) => ProviderOptions | undefined;
	/** Transform outgoing request headers before streamText(). */
	headers?: (
		headers: Record<string, string> | undefined,
		context: ChatTransformContext,
	) => Record<string, string> | undefined;
}

const transforms: ChatRequestTransform[] = [];

export function registerChatRequestTransform(
	transform: ChatRequestTransform,
): () => void {
	transforms.push(transform);
	return () => {
		const index = transforms.indexOf(transform);
		if (index >= 0) transforms.splice(index, 1);
	};
}

export function applySystemTransforms(
	system: SystemParam,
	context: ChatTransformContext,
): SystemParam {
	let current = system;
	for (const transform of transforms) {
		if (transform.system) current = transform.system(current, context);
	}
	return current;
}

export function applyParamsTransforms(
	providerOptions: ProviderOptions | undefined,
	context: ChatTransformContext,
): ProviderOptions | undefined {
	let current = providerOptions;
	for (const transform of transforms) {
		if (transform.params) current = transform.params(current, context);
	}
	return current;
}

export function applyHeaderTransforms(
	headers: Record<string, string> | undefined,
	context: ChatTransformContext,
): Record<string, string> | undefined {
	let current = headers;
	for (const transform of transforms) {
		if (transform.headers) current = transform.headers(current, context);
	}
	return current;
}
