import {readFileSync} from 'fs';
import {Box, Text} from 'ink';
import BigText from 'ink-big-text';
import Gradient from 'ink-gradient';
import {dirname, join} from 'path';
import {memo} from 'react';
import {fileURLToPath} from 'url';
import {TitledBoxWithPreferences} from '@/components/ui/titled-box';
import {
	getNanocoderShape,
	shouldShowWelcomeTips,
	updateLastWelcomeShown,
} from '@/config/preferences';
import {useResponsiveTerminal} from '@/hooks/useTerminalWidth';
import {useTheme} from '@/hooks/useTheme';
import {
	formatGitStatusSummary,
	getGitStatusSummarySync,
} from '@/tools/git/utils';
import type {NanocoderShape} from '@/types/ui';

// Get version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getVersion(): string {
	try {
		const packageJsonPath = join(__dirname, '../../package.json');
		const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
			version: string;
		};
		return packageJson.version;
	} catch {
		return '0.0.0';
	}
}

// Fork banner - custom ASCII art for llupRisinglll's fork
const FORK_BANNER = `▄█▀█▄ █▄░▄█ █▄░█ █ █▀▀ █▀█ █▀▄ █▀▀
▀█▄█▀ █░▀░█ █░▀█ █ █▄▄ █▄█ █▄▀ ██▄`;

function ForkBanner() {
	const {colors} = useTheme();
	return (
		<Gradient colors={colors.bannerGradient ?? [colors.primary, colors.tool]}>
			<Text>{FORK_BANNER}</Text>
		</Gradient>
	);
}

const DEFAULT_SHAPE: NanocoderShape = 'fork';

export interface WelcomeMessageProps {
	currentProvider?: string;
	currentModel?: string;
}

export default memo(function WelcomeMessage({
	currentProvider,
	currentModel,
}: WelcomeMessageProps) {
	const {boxWidth, isNarrow, isNormal} = useResponsiveTerminal();
	const {colors} = useTheme();

	// Get the user's preferred nanocoder shape or use default
	const nanocoderShape = getNanocoderShape() ?? DEFAULT_SHAPE;

	// Determine which banner to show - fork banner is default
	const showForkBanner = nanocoderShape === 'fork';

	// Check if tips should be shown
	const showTips = shouldShowWelcomeTips();

	// Update last shown timestamp
	if (showTips) {
		updateLastWelcomeShown();
	}

	// Get git status for the header
	const gitStatus = getGitStatusSummarySync();
	const gitLabel = gitStatus
		? (() => {
				const {branch, marker} = formatGitStatusSummary(gitStatus);
				return marker ? `⎇ ${branch} (${marker})` : `⎇ ${branch}`;
			})()
		: undefined;

	// Get current directory
	const cwd = process.cwd();
	const homedir = process.env.HOME || process.env.USERPROFILE || '';
	const shortCwd = homedir ? cwd.replace(homedir, '~') : cwd;

	return (
		<>
			{/* Banner — marginTop separates it from the shell prompt that launched us */}
			{showForkBanner ? (
				<Box marginTop={1} marginBottom={1}>
					<ForkBanner />
				</Box>
			) : (
				<Box marginTop={1}>
					<Gradient
						colors={colors.bannerGradient ?? [colors.primary, colors.tool]}
					>
						<BigText text="Nanocoder" font={nanocoderShape} />
					</Gradient>
				</Box>
			)}

			{/* Fork Attribution */}
			<Box marginBottom={1}>
				<Text color={colors.secondary}>
					A fork of nanocoder by llupRisinglll (Luis Edward Miranda)
				</Text>
			</Box>

			{/* Info Header Box */}
			<Box
				borderStyle="round"
				borderColor={colors.primary}
				flexDirection="column"
				paddingX={2}
				paddingY={1}
				marginBottom={1}
			>
				{/* Version */}
				<Box>
					<Text color={colors.secondary}>version: </Text>
					<Text color={colors.info} bold>
						v{getVersion()}
					</Text>
				</Box>

				{/* Provider and Model */}
				{currentProvider && currentModel && (
					<Box>
						<Text color={colors.secondary}>model: </Text>
						<Text color={colors.success} bold>
							{currentModel}
						</Text>
					</Box>
				)}

				{/* Directory */}
				<Box>
					<Text color={colors.secondary}>directory: </Text>
					<Text color={colors.text}>{shortCwd}</Text>
				</Box>

				{/* Git Branch */}
				{gitLabel && (
					<Box>
						<Text color={colors.secondary}>branch: </Text>
						<Text color={colors.primary}>{gitLabel}</Text>
					</Box>
				)}
			</Box>

			{/* Tips - only show on first run or after 12+ hours */}
			{showTips && (
				<>
					{isNarrow ? (
						<Box
							flexDirection="column"
							marginBottom={1}
							borderStyle="round"
							borderColor={colors.primary}
							paddingY={1}
							paddingX={2}
						>
							<Box marginBottom={1}>
								<Text color={colors.primary} bold>
									Tips
								</Text>
							</Box>

							<Text color={colors.secondary}>• Use natural language</Text>
							<Text color={colors.secondary}>• /help for commands</Text>
							<Text color={colors.secondary}>• Ctrl+C to quit</Text>
						</Box>
					) : (
						<TitledBoxWithPreferences
							title="Tips"
							width={boxWidth}
							borderColor={colors.primary}
							paddingX={2}
							paddingY={1}
							flexDirection="column"
							marginBottom={1}
						>
							<Box paddingBottom={1} flexDirection="column">
								<Text color={colors.secondary}>
									{isNormal
										? '1. Use natural language to describe your task.'
										: '1. Use natural language to describe what you want to build.'}
								</Text>
								<Text color={colors.secondary}>
									2. Ask for file analysis, editing, bash commands and more.
								</Text>
								<Text color={colors.secondary}>
									{isNormal
										? '3. Be specific for best results.'
										: '3. Be specific as you would with another engineer for best results.'}
								</Text>
								<Text color={colors.secondary}>
									4. Type /exit or press Ctrl+C to quit.
								</Text>
							</Box>
							<Text color={colors.text}>/help for help</Text>
						</TitledBoxWithPreferences>
					)}
				</>
			)}
		</>
	);
});
