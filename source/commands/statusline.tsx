import {Box, Text} from 'ink';
import React from 'react';
import {loadPreferences, savePreferences} from '@/config/preferences';
import type {Command} from '@/types/commands';
import type {StatusLineConfig} from '@/types/statusline';

function StatusHelp() {
	return (
		<Box flexDirection="column" gap={1}>
			<Text bold>/statusline — configure the persistent status bar</Text>
			<Text dimColor>Usage:</Text>
			<Text>
				{'  '}
				<Text bold>/statusline</Text>
				<Text dimColor> — show current statusline config</Text>
			</Text>
			<Text>
				{'  '}
				<Text bold>/statusline on</Text>
				<Text dimColor> — enable the built-in statusline</Text>
			</Text>
			<Text>
				{'  '}
				<Text bold>/statusline off</Text>
				<Text dimColor> — disable the statusline</Text>
			</Text>
			<Text>
				{'  '}
				<Text bold>/statusline command &lt;shell-cmd&gt;</Text>
				<Text dimColor> — run a custom shell command</Text>
			</Text>
			<Text>
				{'  '}
				<Text bold>/statusline position top|bottom</Text>
				<Text dimColor> — render above or below the input area</Text>
			</Text>
			<Text>
				{'  '}
				<Text bold>/statusline reset</Text>
				<Text dimColor> — clear custom command, use built-in</Text>
			</Text>
			<Text dimColor>
				{'\n'}Custom commands receive JSON on stdin with: model, workspace, git,
				context, version.
			</Text>
			<Text dimColor>
				The command's stdout is rendered at the configured position.
			</Text>
		</Box>
	);
}

function StatusResult({config}: {config: StatusLineConfig | undefined}) {
	const enabled = config?.enabled ?? false;
	const command = config?.command;
	const padding = config?.padding ?? 0;
	const position = config?.position ?? 'bottom';

	return (
		<Box flexDirection="column" gap={1}>
			<Text bold>Statusline</Text>
			<Text>
				Enabled:{' '}
				<Text color={enabled ? 'green' : 'red'}>{enabled ? 'yes' : 'no'}</Text>
			</Text>
			{command && (
				<Text>
					Command: <Text color="cyan">{command}</Text>
				</Text>
			)}
			{!command && enabled && (
				<Text>
					Mode: <Text color="cyan">built-in</Text>
				</Text>
			)}
			{enabled && (
				<Text>
					Position: <Text color="cyan">{position}</Text>
				</Text>
			)}
			{padding > 0 && (
				<Text>
					Padding: <Text color="cyan">{padding}</Text>
				</Text>
			)}
		</Box>
	);
}

function StatusResponse({message}: {message: string}) {
	return (
		<Box padding={1}>
			<Text color="green">{message}</Text>
		</Box>
	);
}

function StatusError({message}: {message: string}) {
	return (
		<Box padding={1}>
			<Text color="red">{message}</Text>
		</Box>
	);
}

export const statuslineCommand = {
	name: 'statusline',
	description:
		'Configure the persistent status bar at the bottom of the terminal',
	handler: async (args: string[]): Promise<React.ReactElement> => {
		const preferences = loadPreferences();
		const subcommand = args[0]?.toLowerCase();

		// No args — show current config
		if (!subcommand) {
			return <StatusResult config={preferences.statusLine} />;
		}

		switch (subcommand) {
			case 'on':
			case 'enable': {
				preferences.statusLine = {
					...(preferences.statusLine ?? {}),
					enabled: true,
				};
				savePreferences(preferences);
				return (
					<StatusResponse message="Statusline enabled (built-in mode). Use /statusline command <cmd> for custom." />
				);
			}

			case 'off':
			case 'disable': {
				preferences.statusLine = {
					...(preferences.statusLine ?? {}),
					enabled: false,
				};
				savePreferences(preferences);
				return <StatusResponse message="Statusline disabled." />;
			}

			case 'command':
			case 'cmd': {
				const cmd = args.slice(1).join(' ').trim();
				if (!cmd) {
					return (
						<StatusError message="Usage: /statusline command <shell-cmd>" />
					);
				}
				preferences.statusLine = {
					enabled: true,
					command: cmd,
					padding: preferences.statusLine?.padding ?? 0,
				};
				savePreferences(preferences);
				return (
					<StatusResponse message={`Custom statusline command set: ${cmd}`} />
				);
			}

			case 'position':
			case 'pos': {
				const pos = args[1]?.toLowerCase();
				if (pos !== 'top' && pos !== 'bottom') {
					return (
						<StatusError message="Usage: /statusline position top|bottom" />
					);
				}
				preferences.statusLine = {
					...(preferences.statusLine ?? {}),
					enabled: true,
					position: pos,
				};
				savePreferences(preferences);
				return (
					<StatusResponse message={`Statusline position set to ${pos}.`} />
				);
			}

			case 'reset':
			case 'clear': {
				preferences.statusLine = {enabled: true};
				savePreferences(preferences);
				return <StatusResponse message="Statusline reset to built-in mode." />;
			}

			case 'help': {
				return <StatusHelp />;
			}

			default: {
				return (
					<StatusError
						message={`Unknown subcommand: ${subcommand}. Try /statusline help`}
					/>
				);
			}
		}
	},
} satisfies Command<React.ReactElement>;
