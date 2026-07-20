import {Box, Text} from 'ink';
import React from 'react';
import ToolMessage from '@/components/tool-message';
import {ThemeContext} from '@/hooks/useTheme';
import {formatSkillDetails} from '@/skills/prompt';
import type {NanocoderToolExport} from '@/types/core';
import {jsonSchema, tool} from '@/types/core';

interface SkillArgs {
	name: string;
}

const executeSkill = async (args: SkillArgs): Promise<string> => {
	const name = (args.name ?? '').trim();
	if (!name) {
		throw new Error('skill requires a "name" (the skill to load).');
	}
	return formatSkillDetails(name);
};

const skillCoreTool = tool({
	description:
		'Load detailed instructions for an available skill. Use this when the user task matches a skill listed in the AVAILABLE SKILLS system prompt section. Returns the skill description plus its command/subagent/tool guidance.',
	inputSchema: jsonSchema<SkillArgs>({
		type: 'object',
		properties: {
			name: {
				type: 'string',
				description:
					'The exact skill name from the AVAILABLE SKILLS list. Example: "pr-reviewer".',
			},
		},
		required: ['name'],
	}),
	execute: async (args, _options) => await executeSkill(args),
});

interface SkillFormatterProps {
	args: SkillArgs;
	result?: string;
}

const SkillFormatter = React.memo(({args, result}: SkillFormatterProps) => {
	const themeContext = React.useContext(ThemeContext);
	if (!themeContext) {
		throw new Error('ThemeContext not found');
	}
	const {colors} = themeContext;

	const messageContent = (
		<Box flexDirection="column">
			<Text color={colors.tool}>⚒ skill</Text>
			<Box>
				<Text color={colors.secondary}>Skill: </Text>
				<Text color={colors.text}>{args.name}</Text>
			</Box>
			{result && (
				<Box marginTop={1}>
					<Text color={colors.secondary}>Loaded instructions</Text>
				</Box>
			)}
		</Box>
	);

	return <ToolMessage message={messageContent} hideBox={true} />;
});

const skillFormatter = (
	args: SkillArgs,
	result?: string,
): React.ReactElement => <SkillFormatter args={args} result={result} />;

export const skillTool: NanocoderToolExport = {
	name: 'skill' as const,
	tool: skillCoreTool,
	formatter: skillFormatter,
	readOnly: true,
};
