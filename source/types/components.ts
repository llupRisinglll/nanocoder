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
}

export type Completion = {name: string; isCustom: boolean};

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
