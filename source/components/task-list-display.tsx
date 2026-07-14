import {Box, Text} from 'ink';
import {TitledBoxWithPreferences} from '@/components/ui/titled-box';
import {useTerminalWidth} from '@/hooks/useTerminalWidth';
import {useTheme} from '@/hooks/useTheme';
import type {Task} from '@/tools/tasks/types';

interface TaskListDisplayProps {
	tasks: Task[];
	title?: string;
}

const STATUS_ICONS: Record<Task['status'], string> = {
	pending: '○',
	in_progress: '◐',
	completed: '✓',
};

export function TaskListDisplay({
	tasks,
	title = 'Tasks',
}: TaskListDisplayProps) {
	const boxWidth = useTerminalWidth();
	const {colors} = useTheme();

	if (tasks.length === 0) {
		return (
			<Box flexDirection="column" marginY={1}>
				<Text color={colors.secondary}>
					No tasks found. Create one with write_tasks.
				</Text>
			</Box>
		);
	}

	const getStatusColor = (status: Task['status']): string => {
		switch (status) {
			case 'completed':
				return colors.success;
			case 'in_progress':
				return colors.warning;
			default:
				return colors.secondary;
		}
	};

	const completedCount = tasks.filter(t => t.status === 'completed').length;
	const progressText = `${completedCount}/${tasks.length}`;

	return (
		<TitledBoxWithPreferences
			title={`${title} (${progressText})`}
			borderColor={colors.primary}
			width={boxWidth}
			paddingX={2}
			paddingY={1}
			flexDirection="column"
		>
			{tasks.map((task, index) => (
				<Box key={task.id} flexDirection="row">
					<Box width={2}>
						<Text color={getStatusColor(task.status)}>
							{STATUS_ICONS[task.status]}
						</Text>
					</Box>
					<Box width={3}>
						<Text color={colors.secondary}>{index + 1}.</Text>
					</Box>
					<Box flexShrink={1}>
						<Text
							wrap="truncate-end"
							color={
								task.status === 'completed' ? colors.secondary : colors.text
							}
						>
							{task.title}
						</Text>
					</Box>
				</Box>
			))}
		</TitledBoxWithPreferences>
	);
}
