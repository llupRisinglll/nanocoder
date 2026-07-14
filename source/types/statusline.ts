/**
 * Status line configuration and data types.
 *
 * Two modes:
 * - Built-in: default `model · cwd · git-branch · ctx%` display
 * - Custom: shell command receiving JSON on stdin, output rendered as-is
 */

export interface StatusLineConfig {
	/** Whether the status line is enabled. */
	enabled: boolean;
	/** Shell command to run for custom status line. When absent, use built-in. */
	command?: string;
	/** Horizontal padding (columns) on each side. Default: 0. */
	padding?: number;
	/** Position relative to the input area. Default: 'bottom'. */
	position?: 'top' | 'bottom';
}

export interface StatusLineData {
	model: {
		id: string;
		display_name: string;
	};
	workspace: {
		current_dir: string;
		project_dir: string;
	};
	git?: {
		branch: string;
		dirty: boolean;
	};
	context?: {
		used_percent: number | null;
	};
	version: string;
}

export interface StatusSegment {
	key: string;
	/** Lower survives longer when terminal narrows. */
	priority: number;
	text: string;
	/** Compact form swapped in before segment is dropped entirely. */
	shortText?: string;
	color?: string;
}
