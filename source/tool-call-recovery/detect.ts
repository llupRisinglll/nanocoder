/**
 * detect.ts — the DETECT layer of tool-call-recovery.
 *
 * Scans assistant text for EVERY tool-call-shaped fragment a weak/Chinese model
 * might have leaked instead of executing, and returns them as plain
 * `RawToolCallCandidate` data (name-as-written, raw args blob, format, span).
 *
 * It is deliberately tolerant: names get fused with markup, close tags go
 * missing, JSON is half-broken. Detection never repairs — it only locates and
 * classifies. Fuzzy-matching and arg-repair happen downstream.
 *
 * Zero coupling: only local types + Node/JS built-ins. No side effects.
 */

import type {
	DetectLeakedToolCalls,
	RawToolCallCandidate,
	ToolCallFormat,
} from './types';

/** Tokens the corruption fuses onto a real tool name right before markup. */
const NAME_ARTIFACTS = ['parameter', 'param'];

/**
 * Match a `<function=NAME…` opener tolerantly. The name is lazy so it stops at
 * the first structural boundary: a real `>`, whitespace, a fused
 * `parameter`/`param` artifact (THE key bug), or the start of another tag.
 * Group 2 tells us WHICH boundary stopped it, which is how we classify format.
 */
const FUNCTION_OPEN = /<function=([a-zA-Z0-9_]+?)(>|\s|parameter\b|param\b|<)/g;

/** A fenced ```tool_call … ``` block (the fence language names the intent). */
const TOOL_CALL_FENCE = /```tool_call\s*\n([\s\S]*?)```/g;

/** Signature that separates a real tool-call object from ordinary prose JSON:
 * it must carry a name/tool key AND an arguments/parameters key. */
const JSON_NAME_KEY = /"(?:tool|name)"\s*:\s*"([^"]+)"/;
const JSON_HAS_ARGS = /"(?:arguments|parameters)"\s*:/;

/**
 * Walk forward from an opening `{` (or `[`) to its matching close, respecting
 * JSON string literals + escapes so braces inside strings don't miscount.
 * Returns the index just past the closing brace, or -1 if unbalanced.
 */
function matchBrace(text: string, open: number): number {
	const openCh = text[open];
	const closeCh = openCh === '[' ? ']' : '}';
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (let i = open; i < text.length; i++) {
		const ch = text[i];
		if (inStr) {
			if (esc) esc = false;
			else if (ch === '\\') esc = true;
			else if (ch === '"') inStr = false;
			continue;
		}
		if (ch === '"') inStr = true;
		else if (ch === openCh) depth++;
		else if (ch === closeCh) {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	return -1;
}

/** Does [s,e) overlap any already-claimed span? Keeps detectors from
 * double-reporting the same bytes (e.g. JSON scan re-finding a `{json}` that
 * already belongs to a `<function=…>{json}</function>`). */
function overlaps(
	spans: Array<{start: number; end: number}>,
	s: number,
	e: number,
): boolean {
	return spans.some(sp => s < sp.end && e > sp.start);
}

/**
 * Extend a function-tag span backward over a preceding `<tool_call>` wrapper
 * (whitespace tolerated) and forward over a trailing `</tool_call>`, so the
 * salvaged/stripped span covers the whole block the model meant as one call.
 */
function widenToToolCall(
	text: string,
	start: number,
	end: number,
): {start: number; end: number} {
	const before = text.slice(0, start);
	const openMatch = /<tool_call>\s*$/.exec(before);
	if (openMatch) start = openMatch.index;
	const after = text.slice(end);
	const closeMatch = /^\s*<\/tool_call>/.exec(after);
	if (closeMatch) end += closeMatch[0].length;
	return {start, end};
}

/**
 * Find where a function-tag call's body ends, bounded by the next
 * `<function=` so two adjacent calls never merge. Prefers explicit closers
 * (`</function>`, then `</tool_call>`); falls back to the last `</parameter>`
 * (attribute-merged blocks with no `</function>`); finally the current line.
 */
function findCallEnd(
	text: string,
	bodyStart: number,
	limit: number,
): {contentEnd: number; spanEnd: number} {
	const clamp = (i: number) => (i < 0 || i > limit ? -1 : i);

	const fn = clamp(text.indexOf('</function>', bodyStart));
	if (fn >= 0) return {contentEnd: fn, spanEnd: fn + '</function>'.length};

	const tc = clamp(text.indexOf('</tool_call>', bodyStart));
	if (tc >= 0) return {contentEnd: tc, spanEnd: tc};

	// No structural closer: gather trailing </parameter> blocks.
	let lastParam = -1;
	let from = bodyStart;
	for (;;) {
		const p = text.indexOf('</parameter>', from);
		if (p < 0 || p > limit) break;
		lastParam = p + '</parameter>'.length;
		from = lastParam;
	}
	if (lastParam >= 0) return {contentEnd: lastParam, spanEnd: lastParam};

	// Last resort: end of the current line (or the region limit).
	const nl = text.indexOf('\n', bodyStart);
	const lineEnd = nl < 0 || nl > limit ? limit : nl;
	return {contentEnd: lineEnd, spanEnd: lineEnd};
}

/** Detect all `<function=…>` / `<tool_call>` / attribute-merged fragments. */
function detectFunctionCalls(text: string): RawToolCallCandidate[] {
	const out: RawToolCallCandidate[] = [];
	FUNCTION_OPEN.lastIndex = 0;
	let m: RegExpExecArray | null;

	while ((m = FUNCTION_OPEN.exec(text)) !== null) {
		const openStart = m.index;
		const name = m[1];
		const terminator = m[2];
		const matchEnd = m.index + m[0].length;

		const isArtifact = NAME_ARTIFACTS.includes(terminator);
		// A fused `param`/`parameter` immediately followed by `>` is really a
		// clean name that just happens to contain that token — treat as normal.
		const artifactThenGt = isArtifact && text[matchEnd] === '>';

		let rawName: string;
		let bodyStart: number;
		// null until classified from the body shape below (non-artifact cases).
		let format: ToolCallFormat | null;

		if (isArtifact && !artifactThenGt) {
			// THE key bug: `<function=execute_bparameter name="command">…`.
			// Keep the fused artifact ON the name so the fuzzy-matcher strips it.
			rawName = name + terminator;
			bodyStart = matchEnd; // sits at ` name="…">…`
			format = 'attribute-merged';
		} else {
			rawName = artifactThenGt ? name + terminator : name;
			if (terminator === '<') {
				bodyStart = matchEnd - 1; // keep the '<' that starts the next tag
			} else if (artifactThenGt) {
				bodyStart = matchEnd + 1; // skip the trailing '>'
			} else {
				bodyStart = matchEnd; // consumed '>' or a whitespace char
			}
			format = null;
		}

		// Bound this call by the next opener so adjacent calls stay separate.
		FUNCTION_OPEN.lastIndex = matchEnd;
		const peek = FUNCTION_OPEN.exec(text);
		const limit = peek ? peek.index : text.length;
		FUNCTION_OPEN.lastIndex = matchEnd; // resume from just after this opener

		const {contentEnd, spanEnd} = findCallEnd(text, bodyStart, limit);
		const rawArgs = text.slice(bodyStart, contentEnd).trim();

		// Classify the non-artifact cases from the body shape.
		if (format === null) {
			if (rawArgs.startsWith('{')) format = 'function-tag';
			else format = 'xml-tags';
		}

		const {start, end} = widenToToolCall(text, openStart, spanEnd);
		out.push({
			rawName,
			rawArgs,
			format,
			span: {start, end, text: text.slice(start, end)},
		});
	}

	return out;
}

/** Detect fenced ```tool_call … ``` blocks whose body is a tool-call object. */
function detectFencedCalls(
	text: string,
	claimed: Array<{start: number; end: number}>,
): RawToolCallCandidate[] {
	const out: RawToolCallCandidate[] = [];
	TOOL_CALL_FENCE.lastIndex = 0;
	let m: RegExpExecArray | null;

	while ((m = TOOL_CALL_FENCE.exec(text)) !== null) {
		const start = m.index;
		const end = m.index + m[0].length;
		const inner = m[1];
		// The `<function=` scan already owns any XML inside the fence.
		if (overlaps(claimed, start, end)) continue;
		const nameMatch = JSON_NAME_KEY.exec(inner);
		if (!nameMatch || !JSON_HAS_ARGS.test(inner)) continue;

		out.push({
			rawName: nameMatch[1],
			rawArgs: extractJsonArgs(inner) ?? inner.trim(),
			format: 'json',
			span: {start, end, text: text.slice(start, end)},
		});
	}

	return out;
}

/** Pull the `arguments`/`parameters` object text out of a JSON tool-call blob,
 * so downstream repair works on the args, not the wrapper. Falls back to null
 * when the value isn't an object/array we can brace-match. */
function extractJsonArgs(obj: string): string | null {
	const key = /"(?:arguments|parameters)"\s*:\s*/.exec(obj);
	if (!key) return null;
	let i = key.index + key[0].length;
	while (i < obj.length && /\s/.test(obj[i])) i++;
	if (obj[i] !== '{' && obj[i] !== '[') return null;
	const close = matchBrace(obj, i);
	if (close < 0) return null;
	return obj.slice(i, close);
}

/** Detect bare `{"tool"|"name":…, "arguments"|"parameters":…}` objects. */
function detectJsonCalls(
	text: string,
	claimed: Array<{start: number; end: number}>,
): RawToolCallCandidate[] {
	const out: RawToolCallCandidate[] = [];

	for (let i = 0; i < text.length; i++) {
		if (text[i] !== '{') continue;
		if (overlaps(claimed, i, i + 1)) continue;
		const end = matchBrace(text, i);
		if (end < 0) continue;
		const objText = text.slice(i, end);

		const nameMatch = JSON_NAME_KEY.exec(objText);
		if (nameMatch && JSON_HAS_ARGS.test(objText)) {
			out.push({
				rawName: nameMatch[1],
				rawArgs: extractJsonArgs(objText) ?? objText,
				format: 'json',
				span: {start: i, end, text: objText},
			});
			claimed.push({start: i, end});
		}
		// Skip past this object either way — its inner braces aren't new starts.
		i = end - 1;
	}

	return out;
}

/**
 * Scan assistant text for tool-call-shaped fragments (tolerant of corruption).
 *
 * Order matters: XML/function fragments are claimed first (they may embed JSON
 * and fenced XML), then fenced tool-call blocks, then bare JSON — each later
 * pass skips bytes an earlier pass already owns. Results are returned in
 * source order so callers can strip spans left-to-right.
 */
export const detectLeakedToolCalls: DetectLeakedToolCalls = (
	text: string,
): RawToolCallCandidate[] => {
	if (
		!text ||
		(text.indexOf('<function=') < 0 &&
			text.indexOf('{') < 0 &&
			text.indexOf('```tool_call') < 0)
	) {
		return [];
	}

	const fnCandidates = detectFunctionCalls(text);
	const claimed = fnCandidates.map(c => ({
		start: c.span.start,
		end: c.span.end,
	}));

	const fenced = detectFencedCalls(text, claimed);
	for (const c of fenced) claimed.push({start: c.span.start, end: c.span.end});

	const json = detectJsonCalls(text, claimed);

	return [...fnCandidates, ...fenced, ...json].sort(
		(a, b) => a.span.start - b.span.start,
	);
};
