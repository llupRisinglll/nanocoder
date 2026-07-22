import {readFileSync, writeFileSync} from 'fs';
import type {TitleShape} from '@/components/ui/styled-title';
import {getClosestConfigFile} from '@/config/index';
import type {TuneConfig} from '@/types/config';
import type {UserPreferences} from '@/types/index';
import type {NanocoderShape, ThemePreset} from '@/types/ui';
import {logError} from '@/utils/message-queue';

let PREFERENCES_PATH: string | null = null;
let CACHED_CONFIG_DIR: string | undefined = undefined;

function getPreferencesPath(): string {
	// Re-compute path if NANOCODER_CONFIG_DIR has changed (important for tests)
	const currentConfigDir = process.env.NANOCODER_CONFIG_DIR;
	if (!PREFERENCES_PATH || CACHED_CONFIG_DIR !== currentConfigDir) {
		PREFERENCES_PATH = getClosestConfigFile('nanocoder-preferences.json');
		CACHED_CONFIG_DIR = currentConfigDir;
	}
	return PREFERENCES_PATH;
}

// Export for testing purposes - allows tests to reset the cache
export function resetPreferencesCache(): void {
	PREFERENCES_PATH = null;
	CACHED_CONFIG_DIR = undefined;
}

export function loadPreferences(): UserPreferences {
	try {
		const data = readFileSync(getPreferencesPath(), 'utf-8');
		return JSON.parse(data) as UserPreferences;
	} catch (error) {
		logError(`Failed to load preferences: ${String(error)}`);
	}
	return {};
}

export function savePreferences(preferences: UserPreferences): void {
	try {
		writeFileSync(getPreferencesPath(), JSON.stringify(preferences, null, 2));
	} catch (error) {
		logError(`Failed to save preferences: ${String(error)}`);
	}
}

export function updateLastUsed(provider: string, model: string): void {
	const preferences = loadPreferences();
	preferences.lastProvider = provider;
	preferences.lastModel = model;

	// Also save the model for this specific provider
	if (!preferences.providerModels) {
		preferences.providerModels = {};
	}
	preferences.providerModels[provider] = model;

	savePreferences(preferences);
}

export function updateTitleShape(shape: string): void {
	const preferences = loadPreferences();
	preferences.titleShape = shape as TitleShape;
	savePreferences(preferences);
}

export function getTitleShape(): TitleShape | undefined {
	const preferences = loadPreferences();
	return preferences.titleShape;
}

export function updateSelectedTheme(theme: string): void {
	const preferences = loadPreferences();
	preferences.selectedTheme = theme as ThemePreset;
	savePreferences(preferences);
}

export function getLastUsedModel(provider: string): string | undefined {
	const preferences = loadPreferences();
	return preferences.providerModels?.[provider];
}

export function updateNanocoderShape(shape: NanocoderShape): void {
	const preferences = loadPreferences();
	preferences.nanocoderShape = shape;
	savePreferences(preferences);
}

export function getNanocoderShape(): NanocoderShape | undefined {
	const preferences = loadPreferences();
	return preferences.nanocoderShape;
}

/**
 * Check if the welcome tips should be shown.
 * Tips are shown on first run or if it's been more than 12 hours since last shown.
 */
export function shouldShowWelcomeTips(): boolean {
	const preferences = loadPreferences();
	const lastShown = preferences.lastWelcomeShown;

	// First time - show tips
	if (!lastShown) {
		return true;
	}

	// Show tips if more than 12 hours have passed
	const twelveHoursInMs = 12 * 60 * 60 * 1000;
	return Date.now() - lastShown > twelveHoursInMs;
}

/**
 * Update the last welcome shown timestamp.
 */
export function updateLastWelcomeShown(): void {
	const preferences = loadPreferences();
	preferences.lastWelcomeShown = Date.now();
	savePreferences(preferences);
}

export function saveTune(config: TuneConfig): void {
	const preferences = loadPreferences();
	preferences.tune = config;
	savePreferences(preferences);
}

/**
 * Get the notifications config from the preferences file.
 */
export function getNotificationsPreference():
	| import('@/types/config').NotificationsConfig
	| undefined {
	const preferences = loadPreferences();
	return preferences.notifications;
}

/**
 * Save the notifications config to the preferences file.
 */
export function updateNotificationsPreference(
	config: import('@/types/config').NotificationsConfig,
): void {
	const preferences = loadPreferences();
	preferences.notifications = config;
	savePreferences(preferences);
}

/**
 * Get the paste threshold from the preferences file.
 */
export function getPasteThreshold(): number | undefined {
	const preferences = loadPreferences();
	const threshold = preferences.paste?.singleLineThreshold;
	if (typeof threshold === 'number' && threshold > 0) {
		return Math.round(threshold);
	}
	return undefined;
}

/**
 * Save the paste threshold to the preferences file.
 */
export function updatePasteThreshold(threshold: number): void {
	const preferences = loadPreferences();
	if (!preferences.paste) {
		preferences.paste = {singleLineThreshold: Math.round(threshold)};
	} else {
		preferences.paste.singleLineThreshold = Math.round(threshold);
	}
	savePreferences(preferences);
}

/**
 * Get the reasoning expanded preference from preferences or environment
 */
export function getReasoningExpanded(): boolean {
	const preferences = loadPreferences();
	return preferences.reasoningExpanded ?? false;
}

/**
 * Save the reasoning expanded preference
 */
export function updateReasoningExpanded(value: boolean): void {
	const preferences = loadPreferences();
	preferences.reasoningExpanded = value;
	savePreferences(preferences);
}

/**
 * Get the compact tool display preference from preferences or environment
 */
export function getCompactToolDisplay(): boolean {
	const preferences = loadPreferences();
	return preferences.compactToolDisplay ?? true;
}

/**
 * Save the compact tool display preference
 */
export function updateCompactToolDisplay(value: boolean): void {
	const preferences = loadPreferences();
	preferences.compactToolDisplay = value;
	savePreferences(preferences);
}

/**
 * Default cap for compact-mode file-diff line counts. 20 covers most
 * single edits without flooding the transcript; 0 means unlimited.
 */
export const DEFAULT_COMPACT_DIFF_MAX_LINES = 20;

/**
 * Get the compact-mode diff line cap from preferences. 0 means unlimited.
 */
export function getCompactDiffMaxLines(): number {
	const preferences = loadPreferences();
	const value = preferences.compactDiffMaxLines;
	if (typeof value === 'number' && value >= 0) {
		return Math.round(value);
	}
	return DEFAULT_COMPACT_DIFF_MAX_LINES;
}

/**
 * Save the compact-mode diff line cap preference. 0 means unlimited.
 */
export function updateCompactDiffMaxLines(value: number): void {
	const preferences = loadPreferences();
	preferences.compactDiffMaxLines = Math.max(0, Math.round(value));
	savePreferences(preferences);
}

/**
 * Get the privacy scrubbing preference from preferences
 */
export function getPrivacyPreference(): boolean {
	const preferences = loadPreferences();
	return preferences.enablePromptScrubbing ?? false;
}

/**
 * Save the privacy scrubbing preference
 */
export function updatePrivacyPreference(value: boolean): void {
	const preferences = loadPreferences();
	preferences.enablePromptScrubbing = value;
	savePreferences(preferences);
}

/**
 * Get the show-working-indicator preference from preferences
 */
export function getShowWorkingIndicator(): boolean {
	const preferences = loadPreferences();
	return preferences.showWorkingIndicator ?? false;
}

/**
 * Save the show-working-indicator preference
 */
export function updateShowWorkingIndicator(value: boolean): void {
	const preferences = loadPreferences();
	preferences.showWorkingIndicator = value;
	savePreferences(preferences);
}

/**
 * Get the alternate-screen (fullscreen) preference. Also settable via
 * --alt-screen/--no-alt-screen at launch; this is the persisted default.
 */
export function getAlternateScreen(): boolean {
	const preferences = loadPreferences();
	return preferences.alternateScreen ?? false;
}

/**
 * Save the alternate-screen preference
 */
export function updateAlternateScreen(value: boolean): void {
	const preferences = loadPreferences();
	preferences.alternateScreen = value;
	savePreferences(preferences);
}

// --- Auto-steering (InnerDaemon) preferences -------------------------------
//
// These two toggles can be mutated from anywhere (the /innerdaemon slash
// command, the Settings dialog). useChatHandler subscribes so the steering
// engine memo can rebuild/teardown reactively; the subscription is a plain
// listener set (no React dependency here).

type SteeringPrefsListener = () => void;
const steeringPrefsListeners = new Set<SteeringPrefsListener>();

/**
 * Subscribe to InnerDaemon preference changes. Returns an unsubscribe fn.
 * Backs a `useSyncExternalStore` in useChatHandler so toggling at runtime
 * rebuilds or tears down the steering engine both directions.
 */
export function subscribeSteeringPrefs(
	listener: SteeringPrefsListener,
): () => void {
	steeringPrefsListeners.add(listener);
	return () => {
		steeringPrefsListeners.delete(listener);
	};
}

function emitSteeringPrefsChanged(): void {
	for (const listener of steeringPrefsListeners) listener();
}

/** Whether auto-steering (InnerDaemon) is enabled. Default true. */
export function getSteeringEnabled(): boolean {
	const preferences = loadPreferences();
	return preferences.steeringEnabled ?? true;
}

/** Enable/disable auto-steering (InnerDaemon) and notify subscribers. */
export function updateSteeringEnabled(value: boolean): void {
	const preferences = loadPreferences();
	preferences.steeringEnabled = value;
	savePreferences(preferences);
	emitSteeringPrefsChanged();
}

/** Whether the verbose "proof-of-life" trace is on. Default false. */
export function getSteeringVerbose(): boolean {
	const preferences = loadPreferences();
	return preferences.steeringVerbose ?? false;
}

/** Toggle the verbose "proof-of-life" trace and notify subscribers. */
export function updateSteeringVerbose(value: boolean): void {
	const preferences = loadPreferences();
	preferences.steeringVerbose = value;
	savePreferences(preferences);
	emitSteeringPrefsChanged();
}

/**
 * The model the InnerDaemon steering subagent runs on. null (default) = inherit
 * the main agent's current session model — today's `model: inherit` behavior.
 * A non-null value overrides it with a specific model id (on the current
 * provider). Returns null when unset so callers get an explicit "inherit".
 */
export function getInnerDaemonModel(): string | null {
	const preferences = loadPreferences();
	return preferences.innerDaemonModel ?? null;
}

/**
 * Set (or clear) the InnerDaemon model and notify subscribers so the steering
 * executor re-binds with the new model resolver. Pass null to restore the
 * default (inherit the main agent model).
 */
export function updateInnerDaemonModel(value: string | null): void {
	const preferences = loadPreferences();
	preferences.innerDaemonModel = value;
	savePreferences(preferences);
	emitSteeringPrefsChanged();
}
