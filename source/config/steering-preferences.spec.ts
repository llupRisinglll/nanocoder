import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'ava';

// CRITICAL: isolate preference reads/writes to a temp dir BEFORE any
// @/config import, so the machine's real nanocoder-preferences.json (which may
// carry a fork-only selectedTheme etc.) never leaks in or gets mutated.
process.env.NANOCODER_CONFIG_DIR = mkdtempSync(
	join(tmpdir(), 'nanocoder-steering-prefs-'),
);
const {
	resetPreferencesCache,
	getSteeringEnabled,
	updateSteeringEnabled,
	getSteeringVerbose,
	updateSteeringVerbose,
	subscribeSteeringPrefs,
} = await import('@/config/preferences');
resetPreferencesCache();

console.log('\nconfig/steering-preferences.spec.ts');

test.serial('steeringEnabled defaults to true (steering on out of the box)', t => {
	// Fresh temp config dir → no key set → default must be enabled.
	t.true(getSteeringEnabled());
});

test.serial(
	'disabling steering flips the pref both directions (drives the engine gate)',
	t => {
		updateSteeringEnabled(false);
		t.false(
			getSteeringEnabled(),
			'when false, useChatHandler memo returns a null engine → loop skips evaluation',
		);
		updateSteeringEnabled(true);
		t.true(getSteeringEnabled(), 're-enabling rebuilds the engine');
	},
);

test.serial('steeringVerbose defaults to off and toggles both directions', t => {
	updateSteeringVerbose(false);
	t.false(getSteeringVerbose(), 'proof-of-life trace is silent by default');
	updateSteeringVerbose(true);
	t.true(getSteeringVerbose());
	updateSteeringVerbose(false);
	t.false(getSteeringVerbose());
});

test.serial(
	'subscribeSteeringPrefs notifies on change so the engine can rebuild at runtime',
	t => {
		let notifications = 0;
		const unsubscribe = subscribeSteeringPrefs(() => {
			notifications++;
		});

		updateSteeringEnabled(false);
		updateSteeringVerbose(true);
		t.is(notifications, 2, 'each toggle notifies subscribers exactly once');

		unsubscribe();
		updateSteeringEnabled(true);
		t.is(notifications, 2, 'no notification after unsubscribe');

		// Restore defaults for any later readers.
		updateSteeringVerbose(false);
	},
);
