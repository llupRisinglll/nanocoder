/**
 * tool-call-recovery — the exportable contract.
 *
 * A harness-agnostic layer that RECOVERS malformed / text-leaked LLM tool calls
 * (the failure mode common to weak & Chinese open models — mimo, qwen, deepseek,
 * minimax — that emit tool calls as broken text instead of executing them).
 *
 * DESIGN RULE: this module has ZERO coupling to any host harness. Its inputs are
 * generic (raw text, a list of tool names, optional JSON schemas) and its outputs
 * are plain data. That is what lets it be extracted verbatim into a standalone
 * package (`@…/tool-call-recovery`) and reused by any LLM app. Do NOT import host
 * types (AI SDK, nanocoder, ink, etc.) into this directory — the host adapts to
 * THIS contract, never the reverse.
 */

/** A minimal JSON-Schema-ish shape (only what arg-repair reads). Kept local so
 * the module needs no schema library. */
export interface JSONSchemaLike {
	type?: string;
	properties?: Record<string, JSONSchemaLike>;
	items?: JSONSchemaLike;
	required?: string[];
	enum?: unknown[];
}

/** How the candidate was written in the text — drives which repair heuristics run. */
export type ToolCallFormat =
	| 'xml-tags' // <tool_call><function=name><parameter name="x">…</parameter>
	| 'function-tag' // <function=name>{json}</function>
	| 'attribute-merged' // corrupted: <function=execute_bparameter name="command">…
	| 'json'; // {"tool":"name","arguments":{…}} or {"name":…,"parameters":…}

/** A tool-call-shaped fragment found in assistant text that was NOT executed. */
export interface RawToolCallCandidate {
	/** Best-effort tool name as written — MAY be garbled (e.g. `execute_bparameter`). */
	rawName: string;
	/** Best-effort raw arguments blob (JSON text, XML params, or key=value pairs). */
	rawArgs: string;
	/** Which detector matched. */
	format: ToolCallFormat;
	/** Character span in the source text (for stripping + before/after display). */
	span: {start: number; end: number; text: string};
}

/** Confidence in a recovery — the host uses this to gate execution (see README §Safety). */
export type RecoveryConfidence =
	| 'exact' // name + args parsed cleanly; safe to treat like a normal call
	| 'fuzzy-name' // tool name was Levenshtein-matched to a registered tool
	| 'repaired-args' // args were jsonrepair'd / coerced
	| 'fuzzy-and-repaired' // both
	| 'learned' // replayed a previously-stored fix for this malformation signature
	| 'llm-repaired'; // salvaged by the injected LLM fallback — LOWEST confidence

/** Traceable record of what was recovered — surfaced to the user as before→after. */
export interface RecoveryProvenance {
	confidence: RecoveryConfidence;
	/** The garbled name, present when `confidence` involved a fuzzy match. */
	originalName?: string;
	/** Human-readable notes on each repair applied ("fuzzy name … → …", "coerced …"). */
	notes: string[];
	/** The exact text span the call was salvaged from. */
	rawText: string;
}

/** A recovered, executable tool call. */
export interface RecoveredToolCall {
	/** A REGISTERED tool name (already matched against the host's tool list). */
	name: string;
	/** Parsed + repaired arguments. */
	arguments: Record<string, unknown>;
	provenance: RecoveryProvenance;
}

/** Outcome of trying to recover a single candidate. */
export type RecoveryOutcome =
	| {kind: 'recovered'; call: RecoveredToolCall}
	/** Name matched >1 tool within threshold — refuse to guess; host should re-prompt. */
	| {
			kind: 'ambiguous';
			reason: string;
			rawName: string;
			matches: string[];
			rawText: string;
	  }
	/** Couldn't salvage a usable call — host should re-prompt with a readable hint. */
	| {kind: 'unrecoverable'; reason: string; rawText: string};

/** Tuning knobs (all optional; sensible defaults in the implementation). */
export interface RecoveryOptions {
	/** Max NORMALIZED Levenshtein distance (0..1) for a fuzzy name match. Default 0.34. */
	maxNameDistance?: number;
	/** Attempt argument coercions (null-optional drop, string→array, unwrap). Default true. */
	coerceArgs?: boolean;
	/**
	 * Tokens sometimes fused onto a tool name by the corruption (e.g. a trailing
	 * `parameter`/`param`) that should be stripped BEFORE fuzzy-matching. Default
	 * `['parameter', 'param']`.
	 */
	nameArtifacts?: string[];
}

/** Host-supplied context — generic, no harness types. */
export interface RecoveryContext {
	/** The registered tool names to match candidates against. */
	toolNames: string[];
	/** Optional JSON schemas keyed by tool name (enables arg validation/coercion). */
	schemas?: Record<string, JSONSchemaLike>;
	options?: RecoveryOptions;
}

/** The single top-level result: what to do + the text with recovered calls removed. */
export interface RecoveryResult {
	outcomes: RecoveryOutcome[];
	/** `text` with every recovered/handled candidate span stripped (so it doesn't
	 * render as a final answer). Untouched when no candidates were found. */
	strippedText: string;
	/** True when the text contained at least one tool-call-shaped fragment. */
	hadCandidates: boolean;
}

// --- The public API surface (implemented across the module's files) ----------

/** Scan assistant text for tool-call-shaped fragments (tolerant of corruption). */
export type DetectLeakedToolCalls = (text: string) => RawToolCallCandidate[];

/** Match a (possibly garbled) name to a registered tool. Returns the single best
 * match within threshold, an ambiguity, or null. */
export type FuzzyMatchToolName = (
	rawName: string,
	toolNames: string[],
	options?: RecoveryOptions,
) => {name: string; distance: number} | {ambiguous: string[]} | null;

/** Parse + repair a raw arguments blob into an object (jsonrepair + coercions). */
export type RepairToolArguments = (
	rawArgs: string,
	format: ToolCallFormat,
	schema?: JSONSchemaLike,
	options?: RecoveryOptions,
) => {args: Record<string, unknown>; notes: string[]} | null;

/** Orchestrator: detect → match name → repair args → confidence-tiered outcomes. */
export type RecoverToolCalls = (
	text: string,
	context: RecoveryContext,
) => RecoveryResult;

// --- Tiered fallback + learning (tiers 2–3) ----------------------------------
// The deterministic core (above) can't cover every malformation the model
// invents, but those malformations REPEAT. So on a deterministic miss we consult
// a learned-pattern store (free replay of a shape we've fixed before), then an
// injected LLM fallback (handles the novel case). Every LLM fix is recorded so
// the next identical repeat replays for free and the dataset seeds future
// deterministic rules. Both the LLM function and the store are HOST-INJECTED, so
// the module stays free of any LLM/harness coupling.

/** A minimally-corrected call (before it's validated + wrapped in provenance). */
export interface RawFix {
	name: string;
	arguments: Record<string, unknown>;
}

/**
 * LLM-repair function, injected by the host. Given a leaked candidate + context,
 * return a corrected call or null. The host wires whatever model it likes; the
 * module only calls this after the deterministic + learned tiers miss.
 */
export type LlmRepairFn = (
	candidate: RawToolCallCandidate,
	context: RecoveryContext,
) => Promise<RawFix | null>;

/** A recorded recovery — emitted so the host can persist a learning dataset. */
export interface RecoveryObservation {
	/** Stable key for this malformation shape (see {@link CandidateSignature}). */
	signature: string;
	rawText: string;
	format: ToolCallFormat;
	fix: RawFix;
	method: 'learned' | 'llm';
	/** Host-supplied timestamp (the module stays clock-free). */
	at: number;
}

/**
 * A pluggable learned-pattern store — the host persists it (e.g. a JSONL file).
 * `match` replays a known fix for free; `record` grows the store from LLM fixes.
 */
export interface PatternStore {
	match(
		candidate: RawToolCallCandidate,
		context: RecoveryContext,
	): RawFix | null;
	record(observation: RecoveryObservation): void;
}

/** Injected dependencies for the async fallback orchestrator. */
export interface FallbackOptions {
	/** Tier-2 learned-pattern store (consulted before the LLM). */
	patternStore?: PatternStore;
	/** Tier-3 LLM fallback (last resort). */
	llmRepair?: LlmRepairFn;
	/** Timestamp source for observations. Defaults to a 0 stamp (clock-free). */
	now?: () => number;
}

/** Compute the stable signature the store keys on (format + name/arg shape). */
export type CandidateSignature = (candidate: RawToolCallCandidate) => string;

/**
 * Async orchestrator: deterministic core → learned store → LLM fallback, tagging
 * each recovery with its confidence and recording LLM fixes for learning.
 */
export type RecoverWithFallback = (
	text: string,
	context: RecoveryContext,
	fallback?: FallbackOptions,
) => Promise<RecoveryResult>;
