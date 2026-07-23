/**
 * Classic dynamic-programming edit distance + a length-normalized variant.
 *
 * Used by the fuzzy tool-name matcher to score a garbled name against the
 * registered tool list. Pure, dependency-free, no host coupling.
 */

/** Levenshtein edit distance (insertions, deletions, substitutions all cost 1). */
export function levenshtein(a: string, b: string): number {
	// Fast exits keep the common "already equal" / "one side empty" cases cheap.
	if (a === b) return 0;
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;

	// Single rolling row of previous-column costs — O(min) space.
	let prev = new Array<number>(b.length + 1);
	for (let j = 0; j <= b.length; j++) prev[j] = j;

	for (let i = 1; i <= a.length; i++) {
		let diag = prev[0]; // cost from the (i-1, j-1) cell
		prev[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			const next = Math.min(
				prev[j] + 1, // deletion
				prev[j - 1] + 1, // insertion
				diag + cost, // substitution / match
			);
			diag = prev[j];
			prev[j] = next;
		}
	}

	return prev[b.length];
}

/** Edit distance scaled into 0..1 by the longer string's length (0 when equal). */
export function normalizedDistance(a: string, b: string): number {
	return levenshtein(a, b) / Math.max(a.length, b.length, 1);
}
