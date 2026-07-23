import test from 'ava';
import {isStreamStallError} from './stream-stall-detector.js';

test('matches the observed provider stall message', t => {
	t.true(
		isStreamStallError(
			new Error('Stream produced no non-ping SSE event within 95000ms'),
		),
	);
});

test('matches an undici body/headers inactivity timeout (message or code)', t => {
	t.true(isStreamStallError(new Error('UND_ERR_BODY_TIMEOUT: Body Timeout Error')));
	const coded = Object.assign(new Error('terminated'), {
		code: 'UND_ERR_HEADERS_TIMEOUT',
	});
	t.true(isStreamStallError(coded));
});

test('matches a generic stream-stalled / timed-out message', t => {
	t.true(isStreamStallError(new Error('Stream stalled')));
	t.true(isStreamStallError(new Error('The stream timed out')));
});

test('matches a stall wrapped as a cause', t => {
	const wrapped = new Error('Chat request failed', {
		cause: new Error('Stream produced no non-ping SSE event within 95000ms'),
	});
	t.true(isStreamStallError(wrapped));
});

test('does NOT match a legitimate empty model turn', t => {
	// The chat handler has a separate "Model produced no output" path — a stall
	// retry must not swallow it, or an empty turn would loop.
	t.false(isStreamStallError(new Error('Model produced no output')));
	t.false(isStreamStallError(new Error('AI_NoOutputGeneratedError')));
});

test('does NOT match ordinary API errors', t => {
	t.false(isStreamStallError(new Error('400 Bad Request: invalid model')));
	t.false(isStreamStallError(new Error('401 Unauthorized')));
	t.false(isStreamStallError(new Error('rate limit exceeded')));
});

test('handles non-Error inputs safely', t => {
	t.false(isStreamStallError(undefined));
	t.false(isStreamStallError(null));
	t.false(isStreamStallError('some string'));
	t.false(isStreamStallError({message: 'no non-ping SSE event'}));
});
