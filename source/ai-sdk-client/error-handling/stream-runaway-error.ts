/**
 * Thrown when a model stream exceeds a client-side runaway limit — an unbounded
 * generation loop (repetition or endless reasoning) that a free/weak model can
 * fall into. Unlike a stall (silence → the SSE inactivity timeout), a runaway is
 * a FLOOD: the stream keeps producing, so nothing provider-side ever stops it.
 *
 * A runaway must NOT be retried — re-issuing the turn just re-runs the same
 * loop — so the chat handler checks for this before the stall-retry path.
 */
export type StreamRunawayReason = 'output-size' | 'duration' | 'repetition';

export class StreamRunawayError extends Error {
	readonly reason: StreamRunawayReason;
	readonly detail: string;

	constructor(reason: StreamRunawayReason, detail: string) {
		super(`Model output exceeded the runaway limit (${reason}: ${detail})`);
		this.name = 'StreamRunawayError';
		this.reason = reason;
		this.detail = detail;
	}
}

export function isStreamRunawayError(
	error: unknown,
): error is StreamRunawayError {
	return error instanceof StreamRunawayError;
}
