import {createRequire} from 'node:module';
import {computeInlineDiff, type DiffSegment} from '@/utils/inline-diff';

// `diff`'s CJS entry is lazy-loaded the same way `inline-diff.tsx` loads it —
// this module is pure logic with no Ink dependency, but we still don't want
// to force the `diff` module graph onto every startup path that imports
// diff-view types.
const require = createRequire(import.meta.url);

interface StructuredPatchHunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: string[];
}

interface StructuredPatch {
	hunks: StructuredPatchHunk[];
}

type StructuredPatchOptions = {context?: number};

type DiffModule = {
	structuredPatch: (
		oldFileName: string,
		newFileName: string,
		oldStr: string,
		newStr: string,
		oldHeader: string,
		newHeader: string,
		options?: StructuredPatchOptions,
	) => StructuredPatch;
};

let diffLib: DiffModule | null = null;
function loadDiffLib(): DiffModule {
	if (!diffLib) {
		diffLib = require('diff') as DiffModule;
	}
	return diffLib;
}

export type DiffLineKind = 'context' | 'remove' | 'add';

export interface DiffLine {
	kind: DiffLineKind;
	oldLineNo?: number;
	newLineNo?: number;
	text: string;
	segments?: DiffSegment[];
}

export interface ComputeDiffLinesOptions {
	/** Lines of context around each hunk, passed to `structuredPatch`. Default 3. */
	context?: number;
	/**
	 * Fraction of changed characters (relative to the longer of the two
	 * lines) above which a removal/addition pair is treated as a full
	 * rewrite instead of a word-level diff — avoids noisy word-confetti on
	 * lines that share little in common. Default 0.6.
	 */
	changeRatioThreshold?: number;
}

const DEFAULT_CONTEXT = 3;
const DEFAULT_CHANGE_RATIO_THRESHOLD = 0.6;

type RawEntryKind = 'context' | 'remove' | 'add';

interface RawEntry {
	kind: RawEntryKind;
	text: string;
}

/**
 * Parse a hunk's raw `structuredPatch` lines (each prefixed with ' '/'-'/'+')
 * into typed entries. Drops the synthetic "\ No newline at end of file"
 * marker lines `diff` emits — they carry no content of their own, just
 * annotate the entry immediately before them. Strips a trailing `\r` so
 * CRLF source files don't leak raw carriage returns into rendered text.
 */
function parseHunkLines(lines: string[]): RawEntry[] {
	const entries: RawEntry[] = [];

	for (const raw of lines) {
		if (raw.startsWith('\\')) continue; // "\ No newline at end of file"

		const prefix = raw.charAt(0);
		const text = raw.slice(1).replace(/\r$/, '');

		if (prefix === ' ') entries.push({kind: 'context', text});
		else if (prefix === '-') entries.push({kind: 'remove', text});
		else if (prefix === '+') entries.push({kind: 'add', text});
		// Any other prefix is not a content line `structuredPatch` emits;
		// ignore defensively rather than throw.
	}

	return entries;
}

/**
 * Fraction of characters that changed between two lines, based on the
 * unchanged-character length reported by `computeInlineDiff`. 0 means the
 * lines are identical; 1 means nothing in common.
 */
function computeChangeRatio(
	oldText: string,
	newText: string,
	segments: DiffSegment[],
): number {
	const unchangedChars = segments
		.filter(segment => segment.type === 'unchanged')
		.reduce((sum, segment) => sum + segment.text.length, 0);
	const totalChars = Math.max(oldText.length, newText.length, 1);
	return 1 - unchangedChars / totalChars;
}

/**
 * Pair adjacent runs of removals and additions within a hunk 1:1, in order
 * (removal[i] <-> addition[i]), matching the `processAdjacentLines` pattern.
 * Paired lines within the change-ratio threshold get word-diff segments;
 * everything else (rewrites over the threshold, unpaired leftovers) renders
 * as plain remove/add lines.
 */
function emitChangeRun(
	removals: RawEntry[],
	additions: RawEntry[],
	oldLineNo: number,
	newLineNo: number,
	changeRatioThreshold: number,
	out: DiffLine[],
): {oldLineNo: number; newLineNo: number} {
	const pairCount = Math.min(removals.length, additions.length);

	for (let i = 0; i < pairCount; i++) {
		const removal = removals[i];
		const addition = additions[i];
		const segments = computeInlineDiff(removal.text, addition.text);
		const ratio = computeChangeRatio(removal.text, addition.text, segments);

		if (ratio <= changeRatioThreshold) {
			out.push({
				kind: 'remove',
				oldLineNo: oldLineNo++,
				text: removal.text,
				segments: segments.filter(segment => segment.type !== 'added'),
			});
			out.push({
				kind: 'add',
				newLineNo: newLineNo++,
				text: addition.text,
				segments: segments.filter(segment => segment.type !== 'removed'),
			});
		} else {
			out.push({kind: 'remove', oldLineNo: oldLineNo++, text: removal.text});
			out.push({kind: 'add', newLineNo: newLineNo++, text: addition.text});
		}
	}

	for (let i = pairCount; i < removals.length; i++) {
		out.push({kind: 'remove', oldLineNo: oldLineNo++, text: removals[i].text});
	}
	for (let i = pairCount; i < additions.length; i++) {
		out.push({kind: 'add', newLineNo: newLineNo++, text: additions[i].text});
	}

	return {oldLineNo, newLineNo};
}

/**
 * Compute the correctly-aligned, word-diffed line list for a text change.
 * Uses `structuredPatch` (real LCS hunks — not lock-step index walking) so
 * scattered/mid-block edits align the way a real diff viewer would, then
 * pairs adjacent remove/add runs within each hunk for word-level highlight.
 *
 * Returns a flat list across all hunks; consumers that need hunk boundaries
 * can detect them from gaps in `oldLineNo`/`newLineNo`.
 */
export function computeDiffLines(
	oldText: string,
	newText: string,
	options: ComputeDiffLinesOptions = {},
): DiffLine[] {
	const context = options.context ?? DEFAULT_CONTEXT;
	const changeRatioThreshold =
		options.changeRatioThreshold ?? DEFAULT_CHANGE_RATIO_THRESHOLD;

	const {structuredPatch} = loadDiffLib();
	const patch = structuredPatch('old', 'new', oldText, newText, '', '', {
		context,
	});

	const out: DiffLine[] = [];

	for (const hunk of patch.hunks) {
		const entries = parseHunkLines(hunk.lines);
		let oldLineNo = hunk.oldStart;
		let newLineNo = hunk.newStart;
		// A hunk that only adds lines still reports oldStart at the line
		// before the insertion point (or 1, at oldLines === 0); likewise for
		// a hunk that only removes lines. structuredPatch clamps to `1` for
		// an empty side, no adjustment needed for the non-empty side.

		let i = 0;
		while (i < entries.length) {
			const entry = entries[i];

			if (entry.kind === 'context') {
				out.push({
					kind: 'context',
					oldLineNo: oldLineNo++,
					newLineNo: newLineNo++,
					text: entry.text,
				});
				i++;
				continue;
			}

			if (entry.kind === 'remove') {
				const removals: RawEntry[] = [];
				while (i < entries.length && entries[i].kind === 'remove') {
					removals.push(entries[i]);
					i++;
				}
				const additions: RawEntry[] = [];
				while (i < entries.length && entries[i].kind === 'add') {
					additions.push(entries[i]);
					i++;
				}
				const next = emitChangeRun(
					removals,
					additions,
					oldLineNo,
					newLineNo,
					changeRatioThreshold,
					out,
				);
				oldLineNo = next.oldLineNo;
				newLineNo = next.newLineNo;
				continue;
			}

			// entry.kind === 'add' with no preceding removal run (pure insertion).
			const additions: RawEntry[] = [];
			while (i < entries.length && entries[i].kind === 'add') {
				additions.push(entries[i]);
				i++;
			}
			for (const addition of additions) {
				out.push({kind: 'add', newLineNo: newLineNo++, text: addition.text});
			}
		}
	}

	return out;
}
