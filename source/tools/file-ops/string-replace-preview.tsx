import {resolve} from 'node:path';
import {Box, Text} from 'ink';
import React from 'react';
import {computeDiffLines} from '@/components/diff-view/compute';
import DiffView from '@/components/diff-view/DiffView';
import ToolMessage from '@/components/tool-message';
import {getColors} from '@/config/index';
import {DEFAULT_TERMINAL_COLUMNS} from '@/constants';
import type {Colors} from '@/types/index';
import {formatError} from '@/utils/error-formatter';
import {getCachedFileContent} from '@/utils/file-cache';

interface StringReplaceArgs {
	path: string;
	old_str: string;
	new_str: string;
}

export async function formatStringReplacePreview(
	args: StringReplaceArgs,
	result?: string,
	colors?: Colors,
): Promise<React.ReactElement> {
	const themeColors = colors || getColors();
	const {path, old_str, new_str} = args;

	const terminalWidth = process.stdout.columns || DEFAULT_TERMINAL_COLUMNS;

	const isResult = result !== undefined;

	try {
		const absPath = resolve(path);
		const cached = await getCachedFileContent(absPath);
		const fileContent = cached.content;

		// Preview mode - validate old_str exists and is unique
		if (!isResult) {
			const occurrences = fileContent.split(old_str).length - 1;

			if (occurrences === 0) {
				return (
					<ToolMessage
						message={
							<Box flexDirection="column" marginBottom={1}>
								<Text color={themeColors.tool}>⚒ string_replace</Text>
								<Box>
									<Text color={themeColors.secondary}>Path: </Text>
									<Text wrap="truncate-end" color={themeColors.primary}>
										{path}
									</Text>
								</Box>
								<Box flexDirection="column" marginTop={1}>
									<Text color={themeColors.error}>
										✗ Error: Content not found in file. The file may have
										changed since you last read it.
									</Text>
								</Box>
							</Box>
						}
						hideBox={true}
					/>
				);
			}

			if (occurrences > 1) {
				return (
					<ToolMessage
						message={
							<Box flexDirection="column">
								<Text color={themeColors.tool}>⚒ string_replace</Text>
								<Box>
									<Text color={themeColors.secondary}>Path: </Text>
									<Text wrap="truncate-end" color={themeColors.primary}>
										{path}
									</Text>
								</Box>
								<Box flexDirection="column" marginTop={1}>
									<Text color={themeColors.error}>
										✗ Error: Found {occurrences} matches
									</Text>
									<Text color={themeColors.secondary}>
										Add more surrounding context to make the match unique.
									</Text>
								</Box>
							</Box>
						}
						hideBox={true}
					/>
				);
			}
		}

		// Find location of the match in the file
		const searchStr = isResult ? new_str : old_str;
		const matchIndex = fileContent.indexOf(searchStr);
		const beforeContent = fileContent.substring(0, matchIndex);
		const afterContent = fileContent.substring(matchIndex + searchStr.length);
		const beforeLines = beforeContent.split('\n');
		const startLine = beforeLines.length;

		const oldStrLines = old_str.split('\n');
		const newStrLines = new_str.split('\n');
		const contentLines = isResult ? newStrLines : oldStrLines;
		const endLine = startLine + contentLines.length - 1;

		// Reconstruct the full old/new text around the match so DiffView's
		// `structuredPatch` hunking (with its own 3-line context) produces the
		// diff — no more hand-rolled context/pairing here. In preview mode
		// `fileContent` is the pre-edit file; in result mode it's already
		// post-edit (the cache was invalidated after execution), so the
		// reconstruction direction flips accordingly.
		const oldText = isResult
			? beforeContent + old_str + afterContent
			: fileContent;
		const newText = isResult
			? fileContent
			: beforeContent + new_str + afterContent;

		const diffLines = computeDiffLines(oldText, newText);

		const rangeDesc =
			startLine === endLine
				? `line ${startLine}`
				: `lines ${startLine}-${endLine}`;

		return (
			<ToolMessage
				message={
					<Box flexDirection="column">
						<Text color={themeColors.tool}>⚒ string_replace</Text>
						<Box>
							<Text color={themeColors.secondary}>Path: </Text>
							<Text wrap="truncate-end" color={themeColors.primary}>
								{path}
							</Text>
						</Box>
						<Box>
							<Text color={themeColors.secondary}>Location: </Text>
							<Text color={themeColors.text}>{rangeDesc}</Text>
						</Box>
						<Box flexDirection="column" marginTop={1} marginBottom={1}>
							<Text color={themeColors.success}>
								{isResult ? '✓ Replace completed' : '✓ Replacing'}{' '}
								{oldStrLines.length} line{oldStrLines.length > 1 ? 's' : ''}{' '}
								with {newStrLines.length} line
								{newStrLines.length > 1 ? 's' : ''}
							</Text>
							<DiffView
								lines={diffLines}
								width={terminalWidth}
								filePath={path}
							/>
						</Box>
					</Box>
				}
				hideBox={true}
			/>
		);
	} catch (error) {
		return (
			<ToolMessage
				message={
					<Box flexDirection="column">
						<Text color={themeColors.tool}>⚒ string_replace</Text>
						<Box>
							<Text color={themeColors.secondary}>Path: </Text>
							<Text wrap="truncate-end" color={themeColors.primary}>
								{path}
							</Text>
						</Box>
						<Box>
							<Text color={themeColors.error}>Error: </Text>
							<Text color={themeColors.error}>{formatError(error)}</Text>
						</Box>
					</Box>
				}
				hideBox={true}
			/>
		);
	}
}
