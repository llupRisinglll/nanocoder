/**
 * Detects a mid-stream STALL — the model connection went quiet and the stream
 * produced no real event within the provider's inactivity window (e.g.
 * "Stream produced no non-ping SSE event within 95000ms", common with slow or
 * free models, and undici body/headers inactivity timeouts).
 *
 * Stalls are transient: re-issuing the same request usually succeeds, so the
 * chat handler retries the turn instead of dropping it back to the prompt.
 * Deliberately narrow — it must NOT match a model that legitimately returned no
 * output, or real API errors, which should surface rather than loop.
 */
export function isStreamStallError(error: unknown): boolean {
	const message = collectMessages(error).toLowerCase();
	if (!message) {
		return false;
	}

	const stallPatterns = [
		/non-ping sse event/i, // the observed provider stall message
		/no\b.*\bsse event\b.*within \d+\s*ms/i,
		/stream.*(stalled|timed out|timeout)/i,
		/\bbody timeout\b/i, // undici inactivity timeouts
		/und_err_body_timeout/i,
		/\bheaders timeout\b/i,
		/und_err_headers_timeout/i,
	];

	return stallPatterns.some(pattern => pattern.test(message));
}

/**
 * A stall often arrives wrapped (the SDK re-throws with the transport error as
 * `cause`), so join the message chain rather than reading only the top error.
 */
function collectMessages(error: unknown): string {
	const parts: string[] = [];
	let current: unknown = error;
	let depth = 0;
	while (current && depth < 5) {
		if (current instanceof Error) {
			parts.push(current.message);
			if ('code' in current && typeof current.code === 'string') {
				parts.push(current.code);
			}
			current = (current as {cause?: unknown}).cause;
		} else if (typeof current === 'string') {
			parts.push(current);
			break;
		} else {
			break;
		}
		depth++;
	}
	return parts.join(' ');
}
