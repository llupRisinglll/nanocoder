/**
 * Host glue: run the tiered recovery on a malformed / leaked tool-call blob,
 * RECORD every event to the dataset file (recovered or not — the must-have), and
 * return recovered calls as host `ToolCall`s ready to inject into the normal
 * execution path so the conversation auto-resumes instead of stopping.
 *
 * Recording is always-on and best-effort: a data-collection failure must never
 * break the loop (the store guards its own fs).
 */

import type {JSONSchemaLike} from '@/tool-call-recovery';
import {recoverWithFallback} from '@/tool-call-recovery';
import type {LLMClient, ToolCall} from '@/types/core';
import {getRecoveryDatasetStore} from './dataset-store';
import {createLlmRepairFn} from './llm-repair';

export interface HostRecovery {
	toolCall: ToolCall;
	confidence: string;
	/** The exact leaked text this call was salvaged from (for the before→after UI). */
	rawText: string;
	/** The garbled name, when it was fuzzy/LLM-corrected. */
	originalName?: string;
}

export interface RecoverAndRecordResult {
	hadCandidates: boolean;
	recovered: HostRecovery[];
	/** The message text with every handled fragment removed. */
	strippedText: string;
}

export async function recoverAndRecord(opts: {
	rawText: string;
	toolNames: string[];
	schemas?: Record<string, JSONSchemaLike>;
	client: LLMClient;
	model?: string;
	/** Parser/validation error, when the trigger was a parsed-but-invalid call. */
	error?: string;
	makeId: () => string;
}): Promise<RecoverAndRecordResult> {
	const {rawText, toolNames, schemas, client, model, error, makeId} = opts;
	const store = getRecoveryDatasetStore();
	const llmRepair = createLlmRepairFn(client, store);

	const result = await recoverWithFallback(
		rawText,
		{toolNames, schemas},
		{patternStore: store, llmRepair, now: () => Date.now()},
	);

	const recovered: HostRecovery[] = [];
	for (const outcome of result.outcomes) {
		if (outcome.kind === 'recovered') {
			const c = outcome.call;
			// LLM fixes were already recorded by the fallback orchestrator; also
			// record deterministic + learned successes so the dataset is complete.
			if (c.provenance.confidence !== 'llm-repaired') {
				store.logEvent({
					ts: Date.now(),
					model,
					rawText: c.provenance.rawText,
					recovered: true,
					method:
						c.provenance.confidence === 'learned' ? 'learned' : 'deterministic',
					fix: {name: c.name, arguments: c.arguments},
					confidence: c.provenance.confidence,
				});
			}
			recovered.push({
				toolCall: {
					id: makeId(),
					function: {name: c.name, arguments: c.arguments},
				},
				confidence: c.provenance.confidence,
				rawText: c.provenance.rawText,
				originalName: c.provenance.originalName,
			});
		} else {
			// Record the UNRECOVERED failure too — it's data for improving detection
			// and for the LLM agent's future few-shot.
			store.logEvent({
				ts: Date.now(),
				model,
				rawText: outcome.rawText,
				error: error ?? outcome.reason,
				recovered: false,
			});
		}
	}

	return {
		hadCandidates: result.hadCandidates,
		recovered,
		strippedText: result.strippedText,
	};
}
