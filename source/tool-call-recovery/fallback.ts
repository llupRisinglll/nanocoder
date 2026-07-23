/**
 * Tiered fallback + learning orchestrator (tiers 2–3), layered ON TOP of the
 * deterministic core (`recoverToolCalls`). Deterministic miss → learned-store
 * replay → injected LLM fallback → record the fix so the next identical repeat
 * is free. The LLM function and the store are host-injected; this file adds no
 * LLM/harness coupling.
 */

import {detectLeakedToolCalls} from './detect';
import {recoverToolCalls} from './recover';
import type {
	CandidateSignature,
	RawFix,
	RawToolCallCandidate,
	RecoveredToolCall,
	RecoverWithFallback,
	RecoveryContext,
	RecoveryOutcome,
	RecoveryResult,
} from './types';

/**
 * Stable key for a malformation SHAPE — not its exact text. Same tool garbled the
 * same way (same format, same normalized name, same arg-key set) collapses to one
 * signature, so a store keyed on it replays across superficially-different repeats.
 */
export const candidateSignature: CandidateSignature = candidate => {
	const name = candidate.rawName.toLowerCase().replace(/[^a-z0-9_]/g, '');
	// Cheap arg-shape fingerprint: the set of parameter keys, order-independent.
	const keys = Array.from(
		candidate.rawArgs.matchAll(/name=["']([^"']+)["']|"([a-zA-Z0-9_]+)"\s*:/g),
	)
		.map(m => m[1] ?? m[2])
		.filter(Boolean)
		.sort();
	return `${candidate.format}|${name}|${keys.join(',')}`;
};

/** Validate a host/store-supplied fix against the registered tools. */
function isUsableFix(fix: RawFix | null, ctx: RecoveryContext): fix is RawFix {
	return (
		!!fix &&
		typeof fix.name === 'string' &&
		ctx.toolNames.includes(fix.name) &&
		!!fix.arguments &&
		typeof fix.arguments === 'object' &&
		!Array.isArray(fix.arguments)
	);
}

export const recoverWithFallback: RecoverWithFallback = async (
	text,
	ctx,
	fb = {},
) => {
	const det: RecoveryResult = recoverToolCalls(text, ctx);
	// Nothing tool-call-shaped, or no fallback wired → deterministic result stands.
	if (!det.hadCandidates || (!fb.patternStore && !fb.llmRepair)) return det;

	// Join outcomes back to their source candidate by the exact salvaged span text
	// (robust to ordering — every outcome carries its rawText).
	const candidateByText = new Map<string, RawToolCallCandidate>(
		detectLeakedToolCalls(text).map(c => [c.span.text, c]),
	);
	const now = fb.now ?? (() => 0);

	const outcomes: RecoveryOutcome[] = [];
	for (const outcome of det.outcomes) {
		if (outcome.kind === 'recovered') {
			outcomes.push(outcome);
			continue;
		}
		const candidate = candidateByText.get(outcome.rawText);
		if (!candidate) {
			outcomes.push(outcome);
			continue;
		}

		// Tier 2: replay a learned fix (free, no LLM).
		let fix = fb.patternStore?.match(candidate, ctx) ?? null;
		let method: 'learned' | 'llm' = 'learned';

		// Tier 3: injected LLM fallback (last resort).
		if (!isUsableFix(fix, ctx) && fb.llmRepair) {
			fix = await fb.llmRepair(candidate, ctx);
			method = 'llm';
		}

		if (!isUsableFix(fix, ctx)) {
			outcomes.push(outcome); // still unrecoverable/ambiguous
			continue;
		}

		const call: RecoveredToolCall = {
			name: fix.name,
			arguments: fix.arguments,
			provenance: {
				confidence: method === 'learned' ? 'learned' : 'llm-repaired',
				originalName:
					candidate.rawName !== fix.name ? candidate.rawName : undefined,
				notes: [
					method === 'learned'
						? 'replayed a previously-learned fix'
						: 'salvaged by the LLM fallback (verify before running)',
				],
				rawText: outcome.rawText,
			},
		};

		// A brand-new LLM fix graduates into the store so the next repeat is free
		// and the dataset gains a candidate for a future deterministic rule.
		if (method === 'llm') {
			fb.patternStore?.record({
				signature: candidateSignature(candidate),
				rawText: candidate.span.text,
				format: candidate.format,
				fix,
				method,
				at: now(),
			});
		}

		outcomes.push({kind: 'recovered', call});
	}

	// strippedText is unchanged: the deterministic pass already removed EVERY
	// candidate span (recovered or not), which is exactly what we want here too.
	return {outcomes, strippedText: det.strippedText, hadCandidates: true};
};
