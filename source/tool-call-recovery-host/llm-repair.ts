/**
 * Host adapter: the "separate agent" that fixes a malformed tool call via a
 * one-shot LLM completion, using the growing dataset (past broken→fixed pairs)
 * as few-shot reference. This is the `LlmRepairFn` injected into the exportable
 * module's tier-3 fallback. Kept out of the module so it can wire nanocoder's
 * LLMClient without coupling the module to any provider.
 */

import {jsonrepair} from 'jsonrepair';
import type {LlmRepairFn, RawFix, RecoveryContext} from '@/tool-call-recovery';
import type {LLMClient, Message} from '@/types/core';
import type {RecoveryDatasetStore} from './dataset-store';

const SYSTEM =
	'You fix malformed tool calls. A weak model emitted a tool call as broken text instead of executing it. ' +
	'Given the raw broken text, the available tools with their JSON schemas, and past broken→fixed examples, ' +
	'output ONLY the corrected tool call as compact JSON: {"name":"<tool>","arguments":{...}}. ' +
	"The name MUST be exactly one of the available tools. Preserve the model's evident intent (e.g. the shell " +
	'command, the file path). No prose, no code fences — JSON only. If you cannot form a valid call, output ' +
	'{"name":"","arguments":{}}.';

/** Extract {name, arguments} from a possibly-messy LLM response. */
export function parseFix(content: string, toolNames: string[]): RawFix | null {
	const block = content.match(/\{[\s\S]*\}/);
	if (!block) return null;
	let obj: unknown;
	try {
		obj = JSON.parse(jsonrepair(block[0]));
	} catch {
		return null;
	}
	if (!obj || typeof obj !== 'object') return null;
	const rec = obj as {name?: unknown; arguments?: unknown};
	const name = typeof rec.name === 'string' ? rec.name : '';
	if (!name || !toolNames.includes(name)) return null;
	const args =
		rec.arguments &&
		typeof rec.arguments === 'object' &&
		!Array.isArray(rec.arguments)
			? (rec.arguments as Record<string, unknown>)
			: {};
	return {name, arguments: args};
}

export function createLlmRepairFn(
	client: LLMClient,
	store?: RecoveryDatasetStore,
): LlmRepairFn {
	return async (candidate, ctx: RecoveryContext) => {
		const tools = ctx.toolNames
			.map(n => {
				const s = ctx.schemas?.[n];
				return s ? `- ${n}: ${JSON.stringify(s)}` : `- ${n}`;
			})
			.join('\n');
		const examples = (store?.recentFixes(8) ?? [])
			.map(e => `broken: ${e.rawText}\nfixed: ${JSON.stringify(e.fix)}`)
			.join('\n---\n');
		const user = [
			`Broken tool call:\n${candidate.span.text}`,
			`\nAvailable tools:\n${tools}`,
			examples ? `\nPast broken→fixed examples:\n${examples}` : '',
			'\nOutput the corrected call as JSON only.',
		].join('\n');
		const messages: Message[] = [
			{role: 'system', content: SYSTEM},
			{role: 'user', content: user},
		];
		try {
			const response = await client.chat(messages, {}, {onToken: () => {}});
			const content = response.choices[0]?.message.content ?? '';
			return parseFix(content, ctx.toolNames);
		} catch {
			return null;
		}
	};
}
