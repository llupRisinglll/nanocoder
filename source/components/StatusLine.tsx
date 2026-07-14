import {spawn} from 'child_process';
import {Box, Text} from 'ink';
import {memo, useEffect, useRef, useState} from 'react';
import {useTheme} from '@/hooks/useTheme';
import type {StatusLineData} from '@/types/statusline';

interface StatusLineProps {
	command: string;
	data: StatusLineData;
	terminalWidth: number;
	padding?: number;
}

function buildInputJson(data: StatusLineData): string {
	return JSON.stringify({
		model: data.model,
		workspace: data.workspace,
		git: data.git,
		context: data.context,
		version: data.version,
	});
}

export const StatusLine = memo(function StatusLine({
	command,
	data,
	terminalWidth,
	padding = 0,
}: StatusLineProps) {
	const {colors} = useTheme();
	const [output, setOutput] = useState('');
	const [error, setError] = useState<string | null>(null);
	const abortRef = useRef<ReturnType<typeof spawn> | null>(null);

	useEffect(() => {
		// Abort any previous in-flight command
		if (abortRef.current) {
			abortRef.current.kill();
			abortRef.current = null;
		}

		let cancelled = false;
		const input = buildInputJson(data);

		const parts = command.split(/\s+/);
		const cmd = parts[0];
		const args = parts.slice(1);

		const child = spawn(cmd, args, {
			stdio: ['pipe', 'pipe', 'pipe'],
			shell: false,
		});
		abortRef.current = child;

		let stdout = '';
		let stderr = '';

		child.stdout.on('data', (chunk: Buffer) => {
			stdout += chunk.toString();
		});

		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		child.on('close', () => {
			if (cancelled) return;
			abortRef.current = null;
			setOutput(stdout.trim());
			setError(stderr.trim() || null);
		});

		child.on('error', () => {
			if (cancelled) return;
			abortRef.current = null;
			setOutput('');
			setError(`Failed to run: ${command}`);
		});

		// Send JSON to stdin and close
		child.stdin.write(input);
		child.stdin.end();

		return () => {
			cancelled = true;
			if (abortRef.current) {
				abortRef.current.kill();
			}
		};
	}, [command, data]);

	if (error) {
		return (
			<Box justifyContent="flex-end">
				<Text color={colors.error} dimColor>
					statusline: {error}
				</Text>
			</Box>
		);
	}

	if (!output) {
		return null;
	}

	return (
		<Box paddingLeft={padding} paddingRight={padding} justifyContent="flex-end">
			<Text>{output}</Text>
		</Box>
	);
});
