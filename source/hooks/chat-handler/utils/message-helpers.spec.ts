import test from 'ava';
import {displayError} from './message-helpers.js';
import type React from 'react';

test('displayError - handles cancellation errors specially', t => {
	let capturedComponent: React.ReactNode = null;
	const addToChatQueue = (component: React.ReactNode) => {
		capturedComponent = component;
	};
	let transientComponent: React.ReactNode = null;
	const addTransientNotice = (component: React.ReactNode) => {
		transientComponent = component;
	};

	const error = new Error('Operation was cancelled');
	displayError(error, 'test', addToChatQueue, addTransientNotice);

	t.is(capturedComponent, null);
	t.truthy(transientComponent);
	// Check that component was created (we can't easily inspect JSX in tests)
	t.pass();
});

test('displayError - handles generic errors', t => {
	let capturedComponent: React.ReactNode = null;
	const addToChatQueue = (component: React.ReactNode) => {
		capturedComponent = component;
	};

	const error = new Error('Test error');
	displayError(error, 'test', addToChatQueue);

	t.truthy(capturedComponent);
	t.pass();
});

test('displayError - handles non-Error objects', t => {
	let capturedComponent: React.ReactNode = null;
	const addToChatQueue = (component: React.ReactNode) => {
		capturedComponent = component;
	};

	displayError('string error', 'test', addToChatQueue);

	t.truthy(capturedComponent);
	t.pass();
});
