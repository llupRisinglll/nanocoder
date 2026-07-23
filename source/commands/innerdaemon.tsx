import {
	getSteeringEnabled,
	getSteeringVerbose,
	updateSteeringEnabled,
	updateSteeringVerbose,
} from '@/config/preferences';
import type {Command} from '@/types/index';
import {errorMsg, infoMsg, successMsg} from '@/utils/message-factory';

function statusText(): string {
	const enabled = getSteeringEnabled();
	const verbose = getSteeringVerbose();
	return [
		`InnerDaemon (auto-steering): ${enabled ? 'ON' : 'OFF'}`,
		`Verbose proof-of-life trace: ${verbose ? 'ON' : 'OFF'}`,
	].join('\n');
}

/**
 * `/innerdaemon on|off|status|verbose on|off` — toggle the auto-steering
 * engine and its verbose "proof-of-life" trace. Mirrors the behavior-toggle
 * slash-command pattern (`/compact --auto-on/off`, `/privacy`). The setters
 * notify subscribers so the running engine rebuilds/tears down immediately.
 */
export const innerdaemonCommand: Command = {
	name: 'innerdaemon',
	description:
		'Toggle InnerDaemon auto-steering. Usage: /innerdaemon on|off|status|verbose on|off',
	handler: async (args: string[]) => {
		const sub = (args[0] ?? 'status').toLowerCase();

		if (sub === 'status') {
			return infoMsg(statusText(), 'innerdaemon');
		}

		if (sub === 'on' || sub === 'enable') {
			updateSteeringEnabled(true);
			return successMsg('InnerDaemon auto-steering enabled.', 'innerdaemon');
		}

		if (sub === 'off' || sub === 'disable') {
			updateSteeringEnabled(false);
			return successMsg(
				'InnerDaemon auto-steering disabled. Turns run un-steered.',
				'innerdaemon',
			);
		}

		if (sub === 'verbose') {
			const arg = (args[1] ?? '').toLowerCase();
			if (arg === 'on') {
				updateSteeringVerbose(true);
				return successMsg(
					'InnerDaemon verbose trace enabled — a dim line prints each turn.',
					'innerdaemon',
				);
			}
			if (arg === 'off') {
				updateSteeringVerbose(false);
				return successMsg('InnerDaemon verbose trace disabled.', 'innerdaemon');
			}
			// Bare `/innerdaemon verbose` toggles.
			const next = !getSteeringVerbose();
			updateSteeringVerbose(next);
			return successMsg(
				`InnerDaemon verbose trace ${next ? 'enabled' : 'disabled'}.`,
				'innerdaemon',
			);
		}

		return errorMsg(
			`Unknown subcommand: ${sub}. Usage: /innerdaemon on|off|status|verbose on|off`,
			'innerdaemon',
		);
	},
};
