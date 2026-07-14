import {Box, Text} from 'ink';
import React, {memo, useMemo} from 'react';
import {useTheme} from '@/hooks/useTheme';
import type {StatusSegment} from '@/types/statusline';

interface BuiltinStatusLineProps {
	model: {id: string; display_name: string};
	workspace: {current_dir: string; project_dir: string};
	git?: {branch: string; dirty: boolean};
	context?: {used_percent: number | null};
	terminalWidth: number;
	padding?: number;
}

function renderModelName(displayName: string): string {
	const parts = displayName.split('/');
	const short = parts.length > 1 ? parts[parts.length - 1] : displayName;
	if (short.length > 40) {
		return `${short.slice(0, 37)}...`;
	}
	return short;
}

function truncatePath(
	fullPath: string,
	projectDir: string,
	maxLen: number,
): string {
	let rel = fullPath;
	if (fullPath.startsWith(projectDir)) {
		rel = fullPath.slice(projectDir.length) || '~';
	}
	if (rel.length > maxLen) {
		const segments = rel.split('/');
		while (segments.length > 1 && rel.length > maxLen) {
			segments.shift();
			rel = segments.join('/');
		}
	}
	if (rel.length > maxLen) {
		return `...${rel.slice(-(maxLen - 3))}`;
	}
	return rel;
}

function ctxColor(pct: number | null): string | undefined {
	if (pct === null) return undefined;
	if (pct < 50) return 'green';
	if (pct < 80) return 'yellow';
	return 'red';
}

function buildSegments(props: BuiltinStatusLineProps): StatusSegment[] {
	const {model, git, context} = props;
	const cwd = props.workspace.current_dir;
	const projectDir = props.workspace.project_dir;

	const segments: StatusSegment[] = [];

	segments.push({
		key: 'model',
		priority: 0,
		text: renderModelName(model.display_name),
		color: 'cyan',
	});

	segments.push({
		key: 'cwd',
		priority: 1,
		text: truncatePath(cwd, projectDir, 50),
		shortText: truncatePath(cwd, projectDir, 15),
	});

	if (git) {
		const branch =
			git.branch.length > 30 ? `${git.branch.slice(0, 27)}...` : git.branch;
		segments.push({
			key: 'git-branch',
			priority: 2,
			text: `${branch}${git.dirty ? '*' : ''}`,
			color: git.dirty ? 'yellow' : undefined,
		});
	}

	if (context?.used_percent !== null && context?.used_percent !== undefined) {
		const pct = context.used_percent;
		segments.push({
			key: 'ctx',
			priority: 3,
			text: `${Math.round(pct)}% ctx`,
			shortText: `${Math.round(pct)}%`,
			color: ctxColor(pct),
		});
	}

	return segments;
}

const BUDGET_CHARS = 3;

function fitSegments(
	segments: StatusSegment[],
	maxWidth: number,
): StatusSegment[] {
	if (segments.length === 0) return [];

	let total = segments.reduce(
		(sum, seg) => sum + seg.text.length + BUDGET_CHARS,
		0,
	);

	if (total <= maxWidth) return [...segments];

	const result: StatusSegment[] = [];

	for (const seg of segments) {
		if (seg.shortText) {
			const withShort =
				result.reduce((s, r) => s + r.text.length + BUDGET_CHARS, 0) +
				seg.shortText.length +
				BUDGET_CHARS;
			if (withShort <= maxWidth) {
				result.push({...seg, text: seg.shortText});
				continue;
			}
		}
		const withFull =
			result.reduce((s, r) => s + r.text.length + BUDGET_CHARS, 0) +
			seg.text.length +
			BUDGET_CHARS;
		if (withFull <= maxWidth) {
			result.push(seg);
		}
	}

	return result;
}

export const BuiltinStatusLine = memo(function BuiltinStatusLine(
	props: BuiltinStatusLineProps,
) {
	const {colors} = useTheme();
	const padding = props.padding ?? 0;

	const rendered = useMemo(() => {
		const segments = buildSegments(props);
		const fitted = fitSegments(segments, props.terminalWidth - padding * 2 - 2);

		return fitted.map((seg, i) => (
			<React.Fragment key={seg.key}>
				{i > 0 && (
					<Text color={colors.secondary} dimColor>
						{' · '}
					</Text>
				)}
				<Text color={seg.color} dimColor={!seg.color}>
					{seg.text}
				</Text>
			</React.Fragment>
		));
	}, [props, colors.secondary, padding]);

	return (
		<Box paddingLeft={padding} paddingRight={padding} justifyContent="flex-end">
			{rendered}
		</Box>
	);
});
