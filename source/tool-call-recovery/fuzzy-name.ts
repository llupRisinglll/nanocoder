/**
 * fuzzy-name — match a (possibly garbled) tool name to a registered tool.
 *
 * Weak / Chinese open models corrupt tool names in two overlapping ways:
 *   - plain typos / near-misses (`read_flie` for `read_file`), and
 *   - a stray token fused onto the end of the name by the same corruption that
 *     merges the first `<parameter …>` into the `<function=…>` tag — e.g.
 *     `execute_bparameter` (the literal `parameter` glued on after `execute_b`).
 *
 * We defend against both: every rawName is compared to each registered tool as
 * written AND with any trailing artifact (`parameter` / `param`) stripped, and
 * the smallest normalized edit distance across those forms wins. Exact matches
 * short-circuit; a lone match inside the threshold is returned; two matches that
 * sit within a small band of each other are reported as ambiguous rather than
 * guessed. Pure function, no side effects, no host coupling.
 */

import {normalizedDistance} from './levenshtein.js';
import type {FuzzyMatchToolName} from './types';

/** Default fuzzy threshold (mirrors RecoveryOptions.maxNameDistance). */
const DEFAULT_MAX_DISTANCE = 0.34;

/** Default trailing tokens the corruption fuses onto a name (see module header). */
const DEFAULT_NAME_ARTIFACTS = ['parameter', 'param'];

/**
 * A runner-up whose distance is within this band of the best is treated as a
 * genuine tie — we refuse to guess between two near-equal tools.
 */
const AMBIGUITY_BAND = 0.1;

/**
 * The candidate forms to score a rawName against: the lowercased name itself
 * plus one form per trailing artifact stripped (deduped, empties dropped).
 */
function candidateForms(rawName: string, artifacts: string[]): string[] {
	const base = rawName.toLowerCase();
	const forms = new Set<string>([base]);
	for (const artifact of artifacts) {
		const suffix = artifact.toLowerCase();
		// Only strip a NON-empty suffix that the name actually ends with, and
		// never strip it down to nothing.
		if (suffix.length > 0 && base.endsWith(suffix)) {
			const stripped = base.slice(0, base.length - suffix.length);
			if (stripped.length > 0) forms.add(stripped);
		}
	}
	return [...forms];
}

export const fuzzyMatchToolName: FuzzyMatchToolName = (
	rawName,
	toolNames,
	options,
) => {
	const maxDistance = options?.maxNameDistance ?? DEFAULT_MAX_DISTANCE;
	const artifacts = options?.nameArtifacts ?? DEFAULT_NAME_ARTIFACTS;
	const forms = candidateForms(rawName, artifacts);

	// Best (smallest) normalized distance from any candidate form to each tool.
	const scored: {name: string; distance: number}[] = [];
	for (const name of toolNames) {
		const target = name.toLowerCase();
		let best = Number.POSITIVE_INFINITY;
		for (const form of forms) {
			const d = normalizedDistance(form, target);
			if (d < best) best = d;
			if (best === 0) break; // can't beat an exact match
		}
		// Exact match wins immediately, regardless of any other candidates.
		if (best === 0) return {name, distance: 0};
		scored.push({name, distance: best});
	}

	// Keep only tools inside the fuzzy threshold, closest first.
	const within = scored
		.filter(s => s.distance <= maxDistance)
		.sort((a, b) => a.distance - b.distance);

	if (within.length === 0) return null;
	if (within.length === 1) {
		return {name: within[0].name, distance: within[0].distance};
	}

	// More than one candidate survived: accept the single best ONLY when the
	// runner-up is more than AMBIGUITY_BAND worse; otherwise it's a real tie.
	const best = within[0];
	const tied = within.filter(s => s.distance <= best.distance + AMBIGUITY_BAND);
	if (tied.length > 1) {
		return {ambiguous: tied.map(s => s.name)};
	}
	return {name: best.name, distance: best.distance};
};
