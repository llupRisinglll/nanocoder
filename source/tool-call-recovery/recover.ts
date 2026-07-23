/**
 * recover.ts — the ORCHESTRATOR of tool-call-recovery.
 *
 * Ties the three layers together: DETECT tool-call-shaped fragments in the
 * assistant text, FUZZY-MATCH each garbled name to a registered tool, then
 * REPAIR the raw args against the matched tool's schema. Every candidate turns
 * into exactly one `RecoveryOutcome` (recovered / ambiguous / unrecoverable),
 * and every recovered call carries a `provenance` record whose `confidence`
 * tier the host uses to gate execution.
 *
 * Pure function, no side effects, no host coupling — only the sibling layers
 * and the local contract.
 */

import {repairToolArguments} from './arg-repair.js';
import {detectLeakedToolCalls} from './detect.js';
import {fuzzyMatchToolName} from './fuzzy-name.js';
import type {
	RawToolCallCandidate,
	RecoverToolCalls,
	RecoveryConfidence,
	RecoveryOutcome,
	ToolCallFormat,
} from './types';

/**
 * Reconstruct the `<parameter ` opener the corruption ate on an attribute-merged
 * call. Detect keeps the fused `parameter` token ON the name (`execute_bparameter`)
 * for the fuzzy-matcher to strip, which leaves the FIRST param's args blob starting
 * at a bare `name="…">…` with no `<parameter` prefix — a shape arg-repair's XML
 * extractor can't see. Prepending the missing opener turns it back into the
 * well-formed `<parameter name="…">…` pairs arg-repair already handles. Only the
 * eaten-opener case is touched; a blob that already starts with `<parameter`
 * (multi-param calls keep their later openers) passes through unchanged.
 */
function normalizeArgs(rawArgs: string, format: ToolCallFormat): string {
	if (format === 'attribute-merged' && /^name\s*=/i.test(rawArgs)) {
		return `<parameter ${rawArgs}`;
	}
	return rawArgs;
}

/**
 * Pick the confidence tier from what recovery actually did: a fuzzy name match
 * (name distance > 0) and/or arg repairs (any notes) each bump the tier, and
 * both together are the weakest ("fuzzy-and-repaired"). No fuzz + no repairs is
 * a clean "exact".
 */
function pickConfidence(
	fuzzyName: boolean,
	repairedArgs: boolean,
): RecoveryConfidence {
	if (fuzzyName && repairedArgs) return 'fuzzy-and-repaired';
	if (fuzzyName) return 'fuzzy-name';
	if (repairedArgs) return 'repaired-args';
	return 'exact';
}

/** Turn ONE detected candidate into its outcome (see per-branch comments). */
function recoverCandidate(
	candidate: RawToolCallCandidate,
	context: Parameters<RecoverToolCalls>[1],
): RecoveryOutcome {
	const rawText = candidate.span.text;
	const match = fuzzyMatchToolName(
		candidate.rawName,
		context.toolNames,
		context.options,
	);

	// No tool within threshold: nothing safe to run, ask the host to re-prompt.
	if (match === null) {
		return {
			kind: 'unrecoverable',
			reason: `no registered tool matched "${candidate.rawName}"`,
			rawText,
		};
	}

	// Two+ near-equal tools: refuse to guess, surface the tie to the host.
	if ('ambiguous' in match) {
		return {
			kind: 'ambiguous',
			reason: `"${candidate.rawName}" matched multiple tools within threshold`,
			rawName: candidate.rawName,
			matches: match.ambiguous,
			rawText,
		};
	}

	// A single confident name match — now repair the args against its schema.
	const {name, distance} = match;
	const schema = context.schemas?.[name];
	const repaired = repairToolArguments(
		normalizeArgs(candidate.rawArgs, candidate.format),
		candidate.format,
		schema,
		context.options,
	);

	// Name matched but the args blob couldn't be salvaged into an object.
	if (repaired === null) {
		return {
			kind: 'unrecoverable',
			reason: `could not parse arguments for "${name}"`,
			rawText,
		};
	}

	const fuzzyName = distance > 0;
	const argNotes = repaired.notes;
	// A fuzzy-name note leads the list (name recovery happened first), then any
	// per-arg repair notes from arg-repair.
	const notes = fuzzyName
		? [`fuzzy name "${candidate.rawName}" → "${name}"`, ...argNotes]
		: [...argNotes];

	return {
		kind: 'recovered',
		call: {
			name,
			arguments: repaired.args,
			provenance: {
				confidence: pickConfidence(fuzzyName, argNotes.length > 0),
				// Only carry the garbled original when the name was actually fuzzed.
				...(fuzzyName ? {originalName: candidate.rawName} : {}),
				notes,
				rawText,
			},
		},
	};
}

/**
 * Orchestrator: detect → match name → repair args → confidence-tiered outcomes.
 *
 * Every detected candidate becomes one outcome, and every candidate span (no
 * matter its outcome) is stripped from the original text so a leaked call never
 * renders as a final answer. Spans are removed back-to-front so earlier indices
 * stay valid as later slices are cut out.
 */
export const recoverToolCalls: RecoverToolCalls = (text, context) => {
	const candidates = detectLeakedToolCalls(text);

	const outcomes = candidates.map(candidate =>
		recoverCandidate(candidate, context),
	);

	// Strip every handled span from the ORIGINAL text. Descending by start so
	// each cut leaves the not-yet-processed (earlier) indices untouched.
	let strippedText = text;
	const spans = candidates.map(c => c.span).sort((a, b) => b.start - a.start);
	for (const span of spans) {
		strippedText =
			strippedText.slice(0, span.start) + strippedText.slice(span.end);
	}
	strippedText = strippedText.trim();

	return {
		outcomes,
		strippedText,
		hadCandidates: candidates.length > 0,
	};
};
