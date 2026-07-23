import {existsSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'ava';
import {
	loadPreferences,
	resetPreferencesCache,
	savePreferences,
	shouldShowWelcomeTips,
	updateLastWelcomeShown,
} from './preferences';

console.log('\nwelcome-tips.spec.ts');

// Isolate the config directory so we never touch the user's real preferences.
const testConfigDir = join(tmpdir(), `nanocoder-welcome-tips-test-${Date.now()}`);

test.before(() => {
	process.env.NANOCODER_CONFIG_DIR = testConfigDir;
	mkdirSync(testConfigDir, {recursive: true});
	resetPreferencesCache();
});

test.beforeEach(() => {
	// Start every test from a clean preferences file.
	savePreferences({});
});

test.after.always(() => {
	if (existsSync(testConfigDir)) {
		rmSync(testConfigDir, {recursive: true, force: true});
	}
	delete process.env.NANOCODER_CONFIG_DIR;
	resetPreferencesCache();
});

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

test.serial('shouldShowWelcomeTips returns true on first run (no timestamp)', t => {
	const prefs = loadPreferences();
	t.is(prefs.lastWelcomeShown, undefined);
	t.true(shouldShowWelcomeTips());
});

test.serial('shouldShowWelcomeTips hides tips within 12 hours of last shown', t => {
	savePreferences({lastWelcomeShown: Date.now() - (TWELVE_HOURS_MS - 60 * 1000)});
	t.false(shouldShowWelcomeTips());
});

test.serial('shouldShowWelcomeTips shows tips after 12 hours have elapsed', t => {
	savePreferences({lastWelcomeShown: Date.now() - (TWELVE_HOURS_MS + 60 * 1000)});
	t.true(shouldShowWelcomeTips());
});

test.serial('updateLastWelcomeShown persists a timestamp that suppresses tips immediately after', t => {
	t.true(shouldShowWelcomeTips());

	const before = Date.now();
	updateLastWelcomeShown();
	const after = Date.now();

	const stored = loadPreferences().lastWelcomeShown;
	t.true(typeof stored === 'number');
	t.true((stored as number) >= before && (stored as number) <= after);

	// Having just been shown, tips must be suppressed on the next check.
	t.false(shouldShowWelcomeTips());
});
