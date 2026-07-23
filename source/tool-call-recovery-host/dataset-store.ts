/**
 * Host adapter: a JSONL-file-backed dataset of malformed tool-call events.
 *
 * This is the concrete `PatternStore` for nanocoder AND the always-on data sink.
 * The exportable `tool-call-recovery` module stays generic; this file wires it to
 * disk. EVERY detected malformed tool call is appended here (recovered or not) —
 * that dataset is what a separate LLM agent uses as reference to fix new ones,
 * and what future deterministic rules are mined from.
 *
 * Failure to log must NEVER break the conversation loop — all fs ops are guarded.
 */

import {appendFileSync, existsSync, mkdirSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {getConfigPath} from '@/config/paths';
import {
	candidateSignature,
	type PatternStore,
	type RawFix,
	type RawToolCallCandidate,
	type RecoveryContext,
	type RecoveryObservation,
} from '@/tool-call-recovery';

/** One line of the dataset. Superset of an LLM observation — also logs failures. */
export interface DatasetEntry {
	ts: number;
	model?: string;
	/** The exact malformed tool-call text the model emitted. */
	rawText: string;
	format?: string;
	signature?: string;
	/** The parser/validation error, when the failure came from a parsed call. */
	error?: string;
	/** True when we managed to recover an executable call. */
	recovered: boolean;
	method?: 'deterministic' | 'learned' | 'llm';
	fix?: RawFix;
	confidence?: string;
}

const DEFAULT_PATH = join(getConfigPath(), 'tool-call-recovery.jsonl');

export class RecoveryDatasetStore implements PatternStore {
	private readonly path: string;
	/** signature → fix, built lazily from recorded successes; invalidated on write. */
	private index: Map<string, RawFix> | null = null;

	constructor(path: string = DEFAULT_PATH) {
		this.path = path;
	}

	/** Append ANY malformed-tool-call event to the dataset (the must-have sink). */
	logEvent(entry: DatasetEntry): void {
		try {
			mkdirSync(dirname(this.path), {recursive: true});
			appendFileSync(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
			this.index = null;
		} catch {
			// Logging must never throw into the conversation loop.
		}
	}

	/** PatternStore.record — a successful (LLM) fix graduates into the dataset. */
	record(o: RecoveryObservation): void {
		this.logEvent({
			ts: o.at || 0,
			rawText: o.rawText,
			format: o.format,
			signature: o.signature,
			recovered: true,
			method: o.method,
			fix: o.fix,
		});
	}

	/** PatternStore.match — replay a previously-stored fix for this shape (free). */
	match(candidate: RawToolCallCandidate, ctx: RecoveryContext): RawFix | null {
		const fix = this.load().get(candidateSignature(candidate));
		return fix && ctx.toolNames.includes(fix.name) ? fix : null;
	}

	/** Recent successful recoveries, newest first — few-shot examples for the LLM agent. */
	recentFixes(limit = 15): DatasetEntry[] {
		const out: DatasetEntry[] = [];
		for (const e of this.readAll().reverse()) {
			if (e.recovered && e.fix) out.push(e);
			if (out.length >= limit) break;
		}
		return out;
	}

	private load(): Map<string, RawFix> {
		if (this.index) return this.index;
		const map = new Map<string, RawFix>();
		for (const e of this.readAll()) {
			if (e.recovered && e.fix && e.signature) map.set(e.signature, e.fix);
		}
		this.index = map;
		return map;
	}

	private readAll(): DatasetEntry[] {
		if (!existsSync(this.path)) return [];
		try {
			return readFileSync(this.path, 'utf8')
				.split('\n')
				.filter(l => l.trim())
				.map(l => {
					try {
						return JSON.parse(l) as DatasetEntry;
					} catch {
						return null;
					}
				})
				.filter((e): e is DatasetEntry => e !== null);
		} catch {
			return [];
		}
	}
}

/** Process-wide singleton — one dataset file per install. */
let shared: RecoveryDatasetStore | null = null;
export function getRecoveryDatasetStore(): RecoveryDatasetStore {
	if (!shared) shared = new RecoveryDatasetStore();
	return shared;
}
