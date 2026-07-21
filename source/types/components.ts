import {ReactNode} from 'react';

export interface AssistantMessageProps {
	message: string;
	model: string;
}

export interface AssistantReasoningProps {
	reasoning: string;
	expand: boolean;
	/** When reasoning started — used to show elapsed time in the "Thought" header */
	startTime?: number;
}

export interface ChatQueueProps {
	staticComponents?: ReactNode[];
	queuedComponents?: ReactNode[];
	renderLastQueuedComponentLive?: boolean;
	clearKey?: string;
	/**
	 * Render everything in regular flow instead of Ink's Static. Used by the
	 * fullscreen (alternate-screen) layout, where Static has no scrollback
	 * to print into. Only a bounded tail of components is rendered.
	 */
	disableStatic?: boolean;
}

export type Completion = {
	name: string;
	isCustom: boolean;
	description?: string;
};

// Custom command entries offered to the slash-command completion menu.
// A name plus its optional description, so the menu can render descriptions
// for custom/skill commands the same way it does for built-ins.
export type CustomCommandCompletionSource = {
	name: string;
	description?: string;
};

export interface ToolExecutionIndicatorProps {
	toolName: string;
	currentIndex: number;
	totalTools: number;
}

export interface UserMessageProps {
	message: string;
	tokenContent?: string; // Full assembled content for accurate token counting
	imageCount?: number; // Number of image attachments sent with this message
}
