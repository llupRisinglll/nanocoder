/**
 * arg-repair — turn a raw arguments blob into a usable object.
 *
 * Two families of input:
 *   - `json` / `function-tag`: the args are (broken) JSON text. We run it
 *     through `jsonrepair` (fixes single quotes, trailing commas, unquoted
 *     keys, Python literals, …) and `JSON.parse` the result.
 *   - `xml-tags` / `attribute-merged`: the args are a run of
 *     `<parameter name="K">V</parameter>` pairs, often corrupted (single
 *     quotes on the name, a missing `</parameter>`, a trailing `</function>`).
 *     We extract every pair tolerantly and build a flat string map.
 *
 * After parsing, when a schema is supplied we apply a SMALL, deterministic set
 * of coercions that fix the noise weak models add — each one records a note so
 * the host can surface exactly what was changed. Everything here is a pure
 * function: no side effects, no logging, no host coupling.
 */

import {jsonrepair} from 'jsonrepair';
import type {
	JSONSchemaLike,
	RepairToolArguments,
	ToolCallFormat,
} from './types';

/** True for `{}` — an empty plain object (weak models emit these as noise). */
function isEmptyObject(value: unknown): boolean {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		Object.keys(value as Record<string, unknown>).length === 0
	);
}

/** A string that looks numeric (integer or decimal, optional sign). */
function isNumericString(value: string): boolean {
	return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(value.trim());
}

/**
 * Extract every `<parameter name="K">V</parameter>` pair from an XML-ish blob.
 * Tolerant of: single-quoted / unquoted names, a missing `</parameter>`, and a
 * trailing `</function>` / `</tool_call>`. Values are trimmed strings; the value
 * runs until the earliest closing/opening delimiter (or end of input).
 */
function extractXmlParams(raw: string): Record<string, unknown> | null {
	const out: Record<string, unknown> = {};
	// Match each opening tag; the name may be double/single/unquoted.
	const openTag = /<parameter\s+name\s*=\s*["']?([^"'>\s]+)["']?\s*>/gi;
	let found = false;
	let match: RegExpExecArray | null = openTag.exec(raw);
	while (match !== null) {
		const key = match[1];
		const valueStart = match.index + match[0].length;
		// The value ends at the nearest of: its own close tag, the next
		// parameter opening, a wrapping close tag, or end of string.
		const rest = raw.slice(valueStart);
		const endMatch =
			/<\/parameter>|<parameter\s|<\/function>|<\/tool_call>/i.exec(rest);
		const value = (endMatch ? rest.slice(0, endMatch.index) : rest).trim();
		out[key] = value;
		found = true;
		match = openTag.exec(raw);
	}
	return found ? out : null;
}

/** Parse (broken) JSON text into a plain object, or null if unsalvageable. */
function parseJsonArgs(raw: string): Record<string, unknown> | null {
	try {
		const repaired = jsonrepair(raw);
		const parsed: unknown = JSON.parse(repaired);
		// Arguments must be a plain object — arrays/primitives aren't a valid
		// argument map, so treat them as unrecoverable here.
		if (
			typeof parsed === 'object' &&
			parsed !== null &&
			!Array.isArray(parsed)
		) {
			return parsed as Record<string, unknown>;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * If a string is a double-JSON-encoded string (e.g. `"\"hello\""` — a JSON
 * string whose content is itself a JSON string), unwrap one level. Returns the
 * inner string, or null when no unwrap applies.
 */
function unwrapDoubleEncoded(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (!(trimmed.startsWith('"') && trimmed.endsWith('"'))) return null;
	try {
		const inner: unknown = JSON.parse(trimmed);
		return typeof inner === 'string' ? inner : null;
	} catch {
		return null;
	}
}

/**
 * Apply the small set of schema-guided coercions in place, recording a note for
 * each change. Mutates and returns `args` (caller owns a fresh object).
 */
function coerce(
	args: Record<string, unknown>,
	schema: JSONSchemaLike,
	notes: string[],
): void {
	const required = new Set(schema.required ?? []);
	const props = schema.properties ?? {};

	for (const key of Object.keys(args)) {
		// 1) Drop null / {} noise for OPTIONAL keys (weak models emit these to
		//    "fill in" params they were never given).
		const value = args[key];
		if ((value === null || isEmptyObject(value)) && !required.has(key)) {
			delete args[key];
			notes.push(`dropped optional "${key}" (was null/empty)`);
			continue;
		}

		// 2) Unwrap a double-JSON-encoded string, e.g. "\"x\"" → "x".
		const unwrapped = unwrapDoubleEncoded(args[key]);
		if (unwrapped !== null) {
			args[key] = unwrapped;
			notes.push(`unwrapped double-encoded string "${key}"`);
		}

		const prop = props[key];
		if (!prop) continue;
		const current = args[key];

		// 3) string → array where the schema wants an array (JSON list or CSV).
		if (prop.type === 'array' && typeof current === 'string') {
			const trimmed = current.trim();
			let arr: unknown[] | null = null;
			try {
				const parsed: unknown = JSON.parse(trimmed);
				if (Array.isArray(parsed)) arr = parsed;
			} catch {
				// not JSON — fall through to comma split
			}
			if (arr === null) {
				arr = trimmed === '' ? [] : trimmed.split(',').map(s => s.trim());
			}
			args[key] = arr;
			notes.push(`coerced "${key}" string → array`);
			continue;
		}

		// 4) "true"/"false" → boolean, numeric string → number.
		if (prop.type === 'boolean' && typeof current === 'string') {
			const lowered = current.trim().toLowerCase();
			if (lowered === 'true' || lowered === 'false') {
				args[key] = lowered === 'true';
				notes.push(`coerced "${key}" string → boolean`);
			}
		} else if (
			(prop.type === 'number' || prop.type === 'integer') &&
			typeof current === 'string' &&
			isNumericString(current)
		) {
			args[key] = Number(current.trim());
			notes.push(`coerced "${key}" string → number`);
		}
	}
}

/**
 * Parse + repair a raw arguments blob into `{args, notes}`, or null when it
 * can't be salvaged into an object. See module header for the per-format rules.
 */
export const repairToolArguments: RepairToolArguments = (
	rawArgs: string,
	format: ToolCallFormat,
	schema?: JSONSchemaLike,
	options?,
) => {
	let args: Record<string, unknown> | null;

	if (format === 'json' || format === 'function-tag') {
		args = parseJsonArgs(rawArgs);
	} else {
		// 'xml-tags' | 'attribute-merged'
		args = extractXmlParams(rawArgs);
	}

	if (args === null) return null;

	const notes: string[] = [];
	if (schema && options?.coerceArgs !== false) {
		coerce(args, schema, notes);
	}

	return {args, notes};
};
