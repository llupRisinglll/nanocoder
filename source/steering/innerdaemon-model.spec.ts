import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'ava';
import {getSubagentLoader} from '@/subagents/subagent-loader';
import type {ToolManager} from '@/tools/tool-manager';
import type {LLMChatResponse, LLMClient} from '@/types/core';
import {createInnerDaemonExecutor} from './index.js';

// Isolate preference reads/writes for the round-trip test (c) BEFORE the
// dynamic @/config import below, so the machine's real preferences.json (which
// may carry a fork-only selectedTheme etc.) never leaks in or gets mutated.
// Static imports above are hoisted and do NOT read preferences.json, so this
// env is set in time for the dynamic import that does.
process.env.NANOCODER_CONFIG_DIR = mkdtempSync(
	join(tmpdir(), 'nanocoder-innerdaemon-model-'),
);
const {
	resetPreferencesCache,
	getInnerDaemonModel,
	updateInnerDaemonModel,
	subscribeSteeringPrefs,
} = await import('@/config/preferences');
resetPreferencesCache();

console.log('\nsteering/innerdaemon-model.spec.ts');

// ============================================================================
// Configurable InnerDaemon model (finding #10).
//
// InnerDaemon's subagent frontmatter is `model: inherit`. A configured model
// override must take precedence over that so the steering subagent can run on
// a fast, thinking-off model — while an UNSET override must preserve the exact
// inherit behavior (run on the parent's current session model).
// ============================================================================

const SESSION_MODEL = 'session-model';
const FAST_MODEL = 'fast-model';

/**
 * Mock client that records which model was in effect at each `chat()` call.
 * `prepareClient` calls `setModel()` before the subagent conversation and
 * restores it after, so the recorded model IS the model the run executed on.
 */
function createModelTrackingClient(): LLMClient & {modelsDuringChat: string[]} {
	let currentModel = SESSION_MODEL;
	const modelsDuringChat: string[] = [];
	return {
		modelsDuringChat,
		// One turn: return a plain steering decision with no tool calls, so the
		// subagent loop makes exactly one chat() call and returns.
		chat: async (): Promise<LLMChatResponse> => {
			modelsDuringChat.push(currentModel);
			return {
				choices: [{message: {content: 'ACTION: noop\nREASON: on track'}}],
				toolsDisabled: false,
			} as unknown as LLMChatResponse;
		},
		getCurrentModel: () => currentModel,
		setModel: (model: string) => {
			currentModel = model;
		},
		getAvailableModels: async () => [SESSION_MODEL, FAST_MODEL],
		getContextSize: () => 128000,
		getProviderConfig: () => ({
			name: 'TestProvider',
			type: 'openai',
			models: [SESSION_MODEL, FAST_MODEL],
			config: {},
		}),
		clearContext: async () => {},
		getTimeout: () => undefined,
	} as unknown as LLMClient & {modelsDuringChat: string[]};
}

/** Minimal tool manager — InnerDaemon needs no tools for a noop decision. */
function createEmptyToolManager(): ToolManager {
	return {
		getAllTools: () => ({}),
		getToolHandler: () => undefined,
		getToolEntry: () => undefined,
		isReadOnly: () => false,
		getToolFormatter: () => undefined,
		getStreamingFormatter: () => undefined,
	} as unknown as ToolManager;
}

test.before(async () => {
	await getSubagentLoader().initialize();
});

test.serial(
	'(a) no model override → InnerDaemon inherits the session model (default behavior)',
	async t => {
		const client = createModelTrackingClient();
		// No modelResolver passed — exactly today's wiring.
		const executor = createInnerDaemonExecutor(
			createEmptyToolManager(),
			client,
			() => 'normal',
		);

		const result = await executor.execute({
			subagent_type: 'innerdaemon',
			description: 'steering check',
		});

		t.true(result.success);
		t.deepEqual(
			client.modelsDuringChat,
			[SESSION_MODEL],
			'inherit: the run used the parent session model, unchanged',
		);
	},
);

test.serial(
	'(b) model override "fast-model" → InnerDaemon run uses that model',
	async t => {
		const client = createModelTrackingClient();
		const executor = createInnerDaemonExecutor(
			createEmptyToolManager(),
			client,
			() => 'normal',
			() => FAST_MODEL,
		);

		const result = await executor.execute({
			subagent_type: 'innerdaemon',
			description: 'steering check',
		});

		t.true(result.success);
		t.deepEqual(
			client.modelsDuringChat,
			[FAST_MODEL],
			'override: the run switched to the configured InnerDaemon model',
		);
		t.is(
			client.getCurrentModel(),
			SESSION_MODEL,
			'the parent model is restored after the run',
		);
	},
);

test.serial(
	'(b2) empty/blank override falls back to inherit (guards the null path)',
	async t => {
		const client = createModelTrackingClient();
		const executor = createInnerDaemonExecutor(
			createEmptyToolManager(),
			client,
			() => 'normal',
			() => '   ',
		);

		const result = await executor.execute({
			subagent_type: 'innerdaemon',
			description: 'steering check',
		});

		t.true(result.success);
		t.deepEqual(client.modelsDuringChat, [SESSION_MODEL]);
	},
);

test.serial(
	'(c) innerDaemonModel preference round-trips (null default ↔ set ↔ cleared)',
	t => {
		// Fresh temp config dir → unset → default is null (inherit).
		t.is(getInnerDaemonModel(), null, 'defaults to null (inherit)');

		let notifications = 0;
		const unsubscribe = subscribeSteeringPrefs(() => {
			notifications++;
		});

		updateInnerDaemonModel(FAST_MODEL);
		t.is(getInnerDaemonModel(), FAST_MODEL, 'a set value persists');

		updateInnerDaemonModel(null);
		t.is(getInnerDaemonModel(), null, 'clearing restores the inherit default');

		t.is(notifications, 2, 'each change notifies subscribers so the executor re-binds');
		unsubscribe();
	},
);
