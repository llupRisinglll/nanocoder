import {userInfo} from 'node:os';
import {basename} from 'node:path';
import {Box, useInput} from 'ink';
import React, {useMemo} from 'react';
import {ChatHistory} from '@/app/components/chat-history';
import {ChatInput} from '@/app/components/chat-input';
import {ModalSelectors} from '@/app/components/modal-selectors';
import {FileExplorer} from '@/components/file-explorer';
import {IdeSelector} from '@/components/ide-selector';
import PlanReviewPrompt from '@/components/plan-review-prompt';
import {StatusLine} from '@/components/StatusLine';
import {loadPreferences} from '@/config/preferences';
import type {useChatHandler} from '@/hooks/chat-handler';
import type {AppHandlers} from '@/hooks/useAppHandlers';
import type {useAppState} from '@/hooks/useAppState';
import type {useModeHandlers} from '@/hooks/useModeHandlers';
import {useTerminalRows, useTerminalWidth} from '@/hooks/useTerminalWidth';
import {UIStateProvider} from '@/hooks/useUIState';
import type {useUserMessageQueue} from '@/hooks/useUserMessageQueue';
import type {useVSCodeServer} from '@/hooks/useVSCodeServer';
import {getGitStatusSummarySync} from '@/tools/git/utils';
import {isSingleToolProfile, resolveToolProfile} from '@/tools/tool-profiles';
import type {ImageAttachment} from '@/types/core';
import type {RestoredInputDraft, SubmittedInputDraft} from '@/types/hooks';
import type {StatusLineData} from '@/types/statusline';
import {clickEvents} from '@/utils/terminal-mouse';
import type {PendingToolApproval} from '@/utils/tool-approval-queue';
import type {PendingToolConfirmation} from '@/utils/tool-confirm-queue';
import {
	displayCompactCountsSummary,
	getLiveCompactToolExpandHitboxColumns,
} from '@/utils/tool-result-display';

interface InteractiveAppProps {
	appState: ReturnType<typeof useAppState>;
	chatHandler: ReturnType<typeof useChatHandler>;
	modeHandlers: ReturnType<typeof useModeHandlers>;
	appHandlers: AppHandlers;
	vscodeServer: ReturnType<typeof useVSCodeServer>;
	staticComponents: React.ReactNode[];
	transientNoticeComponents?: React.ReactNode[];
	liveComponent: React.ReactNode;
	pendingSubagentApproval: PendingToolApproval | null;
	handleSubagentToolApproval: (confirmed: boolean) => void;
	pendingToolConfirmation: PendingToolConfirmation | null;
	handleToolConfirmation: (confirmed: boolean) => void;
	handleQuestionAnswer: (answer: string) => void;
	handleUserSubmit: (
		message: string,
		displayValue: string,
		images?: ImageAttachment[],
	) => Promise<void>;
	userMessageQueue: ReturnType<typeof useUserMessageQueue>;
	handleIdeSelect: (ide: string) => void;
	clearKey?: string;
	/**
	 * Whether the terminal is on the alternate screen buffer (set by
	 * cli.tsx). Drives the fullscreen fixed-height layout; false renders
	 * the inline Static-based flow with native scrollback.
	 */
	altScreenActive?: boolean;
}

/**
 * The full interactive render tree: chat history + transient modals + chat
 * input. Lifted out of `App.tsx` so the orchestrator can stay focused on
 * hook composition rather than JSX wiring. Every interactive surface that
 * the user can see during a normal session lives here.
 */
export function InteractiveApp({
	appState,
	chatHandler,
	modeHandlers,
	appHandlers,
	vscodeServer,
	staticComponents,
	transientNoticeComponents = [],
	liveComponent,
	pendingSubagentApproval,
	handleSubagentToolApproval,
	pendingToolConfirmation,
	handleToolConfirmation,
	handleQuestionAnswer,
	handleUserSubmit,
	userMessageQueue,
	handleIdeSelect,
	clearKey,
	altScreenActive = false,
}: InteractiveAppProps): React.ReactElement {
	const nextRestoredDraftIdRef = React.useRef(1);
	const [submittedDraft, setSubmittedDraft] =
		React.useState<SubmittedInputDraft | null>(null);
	const [restoredDraft, setRestoredDraft] =
		React.useState<RestoredInputDraft | null>(null);

	const handleToggleCompactDisplay = React.useCallback(() => {
		const expanding = appState.compactToolDisplay;
		appState.setCompactToolDisplay(!expanding);

		// When expanding, flush accumulated counts to static
		if (expanding) {
			const counts = appState.compactToolCountsRef.current;
			if (Object.keys(counts).length > 0) {
				displayCompactCountsSummary(counts, appState.addToChatQueue, {
					expanded: true,
				});
				appState.compactToolCountsRef.current = {};
				appState.setCompactToolCounts(null);
			}
		}
	}, [appState]);

	const handleToggleReasoningExpanded = () => {
		appState.setReasoningExpanded(!appState.reasoningExpanded);
	};

	React.useEffect(() => {
		const hasCompactSummary =
			appState.compactToolCounts &&
			Object.keys(appState.compactToolCounts).length > 0;
		if (!hasCompactSummary) return;

		const hitbox = getLiveCompactToolExpandHitboxColumns(
			appState.compactToolCounts ?? {},
			!appState.compactToolDisplay,
		);
		if (!hitbox) return;

		const onClick = ({x}: {x: number; y: number}) => {
			if (x < hitbox.start || x > hitbox.end) return;
			handleToggleCompactDisplay();
		};

		clickEvents.on('click', onClick);
		return () => {
			clickEvents.off('click', onClick);
		};
	}, [
		appState.compactToolCounts,
		appState.compactToolDisplay,
		handleToggleCompactDisplay,
	]);

	const showModalSelectors =
		(appState.activeMode !== null &&
			appState.activeMode !== 'explorer' &&
			appState.activeMode !== 'ideSelection') ||
		appState.isSettingsMode;

	// Show the plan review bar when the chat handler signals that a turn which
	// STARTED in plan mode ran to completion uninterrupted (planTurnCompleted).
	// Consuming this explicit one-shot signal — rather than inferring from
	// isConversationComplete + the current mode — is what makes it correct: the
	// user can toggle modes or interrupt a running turn, and only the chat
	// handler knows whether a plan was actually produced.
	React.useEffect(() => {
		if (!appState.planTurnCompleted) return;
		appState.setPlanTurnCompleted(false);

		// Already showing (shouldn't normally happen) — nothing to do.
		if (appState.planReviewState) return;

		appState.setPlanReviewState({show: true, originalMessage: ''});
	}, [
		appState.planTurnCompleted,
		appState.planReviewState,
		appState.setPlanTurnCompleted,
		appState.setPlanReviewState,
		appState,
	]);

	// Proceed: once the mode switch to 'normal' (triggered by handlePlanProceed)
	// has propagated, dispatch the "implement the plan" message. Deferring to this
	// effect is essential — dispatching inside the handler would run the turn with
	// the stale plan-mode system prompt and tools, so the model would refuse to
	// edit. The plan is already in the conversation, so no request text is echoed.
	React.useEffect(() => {
		if (!appState.pendingPlanProceed) return;
		if (appState.developmentMode !== 'normal') return;
		appState.setPendingPlanProceed(false);
		void appHandlers.handleMessageSubmit(
			'The plan above is approved. Proceed with implementing it now.',
		);
	}, [
		appState.pendingPlanProceed,
		appState.developmentMode,
		appState.setPendingPlanProceed,
		appHandlers.handleMessageSubmit,
		appState,
	]);

	// Whether there is in-flight work that Escape should immediately cancel.
	// Decision states (tool confirmation, question prompt, subagent approval)
	// own their own Escape handling and must NOT be hijacked into a generation
	// abort, so they are excluded here.
	const cancellable =
		!appState.isToolConfirmationMode &&
		!appState.isQuestionMode &&
		pendingSubagentApproval === null &&
		pendingToolConfirmation === null &&
		(appState.isCancelling ||
			chatHandler.isGenerating ||
			appState.isToolExecuting ||
			appState.abortController !== null);

	const recallableSubmittedDraft =
		cancellable &&
		chatHandler.isGenerating &&
		chatHandler.streamingContent === '' &&
		!appState.isToolExecuting &&
		submittedDraft !== null;

	React.useEffect(() => {
		if (!submittedDraft) return;

		if (!cancellable || chatHandler.streamingContent !== '') {
			setSubmittedDraft(null);
		}
	}, [cancellable, chatHandler.streamingContent, submittedDraft]);

	const handleSubmittedDraft = React.useCallback(
		(draft: SubmittedInputDraft) => {
			setSubmittedDraft({
				inputState: {
					displayValue: draft.inputState.displayValue,
					placeholderContent: {...draft.inputState.placeholderContent},
				},
				attachments: [...draft.attachments],
			});
		},
		[],
	);

	const handleRecallSubmittedDraft = React.useCallback(() => {
		if (!submittedDraft) {
			appHandlers.handleCancel();
			return;
		}

		appHandlers.handleCancel();

		if (appState.messages[appState.messages.length - 1]?.role === 'user') {
			appState.updateMessages(appState.messages.slice(0, -1));

			if (appState.chatComponents.length > 0) {
				appState.setChatComponents(appState.chatComponents.slice(0, -1));
			}
		}

		appState.setIsCancelling(false);
		appState.setAbortController(null);
		setRestoredDraft({
			id: nextRestoredDraftIdRef.current++,
			inputState: {
				displayValue: submittedDraft.inputState.displayValue,
				placeholderContent: {...submittedDraft.inputState.placeholderContent},
			},
			attachments: [...submittedDraft.attachments],
		});
		setSubmittedDraft(null);
	}, [
		appHandlers,
		appState.messages,
		appState.updateMessages,
		appState.chatComponents,
		appState.setChatComponents,
		appState.setIsCancelling,
		appState.setAbortController,
		submittedDraft,
	]);

	// Single, always-mounted authority for Escape -> cancel. Because this lives
	// at the section level (never swapped out like the ChatInput children), it
	// fires on the FIRST press no matter what is running: an LLM message, a
	// regular tool behind ToolExecutionIndicator, a bash command, or a subagent.
	// `isActive` keeps it dormant when there's nothing to cancel, so idle Escape
	// still drives the clear-input behaviour in UserInput.
	useInput(
		(_input, key) => {
			if (key.escape) {
				if (recallableSubmittedDraft) {
					handleRecallSubmittedDraft();
					return;
				}

				appHandlers.handleCancel();
			}
		},
		{isActive: cancellable},
	);

	const terminalRows = useTerminalRows();
	const terminalWidth = useTerminalWidth();
	const statusLineConfig = loadPreferences().statusLine;
	const statusInfo = useMemo(() => {
		let git:
			| {
					branch: string;
					dirty: boolean;
			  }
			| undefined;
		try {
			const gs = getGitStatusSummarySync();
			if (gs) {
				git = {
					branch: gs.branch,
					dirty: gs.detached || gs.isDefault,
				};
			}
		} catch {}

		return {
			user: userInfo().username,
			directory: basename(process.cwd()),
			git,
		};
	}, []);
	const statusLineData = useMemo<StatusLineData | null>(() => {
		if (!statusLineConfig?.enabled) return null;

		let git: StatusLineData['git'];
		try {
			const gs = getGitStatusSummarySync();
			if (gs) {
				git = {
					branch: gs.branch,
					dirty: gs.detached || gs.isDefault,
				};
			}
		} catch {}

		return {
			model: {
				id: appState.currentModel,
				display_name: appState.currentModel,
			},
			workspace: {
				current_dir: process.cwd(),
				project_dir: process.cwd(),
			},
			git,
			context: {
				used_percent: appState.contextPercentUsed,
			},
			tune: {
				enabled: appState.tune.enabled,
				profile: appState.tune.toolProfile,
				resolved_profile: resolveToolProfile(
					appState.tune.toolProfile,
					appState.currentModel,
				),
				tool_mode: isSingleToolProfile(
					appState.tune.toolProfile,
					appState.currentModel,
				)
					? 'single'
					: 'parallel',
			},
			version: '1.28.1',
		};
	}, [
		statusLineConfig,
		appState.currentModel,
		appState.contextPercentUsed,
		appState.tune,
	]);
	const statusLineSlot =
		statusLineConfig?.enabled && statusLineConfig.command && statusLineData ? (
			<StatusLine
				command={statusLineConfig.command}
				data={statusLineData}
				terminalWidth={terminalWidth}
				padding={statusLineConfig.padding ?? 0}
			/>
		) : null;

	// Fullscreen layout if and only if cli.tsx put us on the alternate
	// screen. Inline mode (--no-alt-screen / alternateScreen:false pref),
	// test renderers, and piped stdout all use the classic flow layout
	// with Static + native scrollback.
	const fullscreen = altScreenActive;

	return (
		// Fullscreen layout on the alternate screen buffer: the root Box is
		// pinned to the exact terminal height so the frame can never exceed
		// the viewport. The chat area (ChatHistory) flexes and clips at the
		// top; everything below it (modals, status line, input) keeps its
		// natural height, so Yoga shrinks the chat area to make room — the
		// input can never be pushed off-screen.
		<Box
			flexDirection="column"
			padding={1}
			width="100%"
			height={fullscreen ? terminalRows : undefined}
		>
			{/* Chat area — fullscreen bottom-anchored viewport */}
			<ChatHistory
				startChat={appState.startChat}
				staticComponents={staticComponents}
				queuedComponents={appState.chatComponents}
				liveComponent={liveComponent}
				renderLastQueuedComponentLive={recallableSubmittedDraft}
				clearKey={clearKey}
				fullscreen={fullscreen}
				scrollActive={
					!showModalSelectors &&
					!appState.isExplorerMode &&
					!appState.isIdeSelectionMode
				}
			/>

			{/* Footer: modals, status line, input. flexShrink=0 so the chat
			    viewport above absorbs ALL vertical shrink — without it Yoga
			    crushes the input box when the transcript is tall. */}
			<Box flexDirection="column" flexShrink={0}>
				{transientNoticeComponents.length > 0 && (
					<Box flexDirection="column" marginBottom={1}>
						{transientNoticeComponents}
					</Box>
				)}

				{appState.planReviewState?.show && (
					<PlanReviewPrompt
						onProceed={appHandlers.handlePlanProceed}
						onAskMore={() => void appHandlers.handlePlanAskMore()}
						onModify={appHandlers.handlePlanModify}
						onDismiss={appHandlers.handlePlanModify}
					/>
				)}

				{appState.isExplorerMode && (
					<Box marginLeft={-1} flexDirection="column">
						<FileExplorer onClose={modeHandlers.handleExplorerCancel} />
					</Box>
				)}

				{appState.isIdeSelectionMode && (
					<Box marginLeft={-1} flexDirection="column">
						<IdeSelector
							onSelect={handleIdeSelect}
							onCancel={modeHandlers.handleIdeSelectionCancel}
						/>
					</Box>
				)}

				{showModalSelectors && (
					<Box marginLeft={-1} flexDirection="column">
						<ModalSelectors
							activeMode={appState.activeMode}
							isSettingsMode={appState.isSettingsMode}
							showAllSessions={appState.showAllSessions}
							currentModel={appState.currentModel}
							currentProvider={appState.currentProvider}
							checkpointLoadData={appState.checkpointLoadData}
							onModelSelect={modeHandlers.handleModelSelect}
							onModelSelectionCancel={modeHandlers.handleModelSelectionCancel}
							onModelDatabaseCancel={modeHandlers.handleModelDatabaseCancel}
							onConfigWizardComplete={modeHandlers.handleConfigWizardComplete}
							onConfigWizardCancel={modeHandlers.handleConfigWizardCancel}
							onMcpWizardComplete={modeHandlers.handleMcpWizardComplete}
							onMcpWizardCancel={modeHandlers.handleMcpWizardCancel}
							onSettingsCancel={modeHandlers.handleSettingsCancel}
							tuneConfig={appState.tune}
							onTuneSelect={modeHandlers.handleTuneSelect}
							onTuneCancel={modeHandlers.handleTuneCancel}
							onCheckpointSelect={appHandlers.handleCheckpointSelect}
							onCheckpointCancel={appHandlers.handleCheckpointCancel}
							onSessionSelect={sessionId =>
								void appHandlers.handleSessionSelect(sessionId)
							}
							onSessionCancel={appHandlers.handleSessionCancel}
						/>
					</Box>
				)}

				{appState.startChat &&
					appState.activeMode === null &&
					!appState.isSettingsMode &&
					!appState.planReviewState?.show && (
						<UIStateProvider>
							<ChatInput
								isCancelling={appState.isCancelling}
								isToolExecuting={appState.isToolExecuting}
								isQuestionMode={appState.isQuestionMode}
								pendingToolCalls={appState.pendingToolCalls}
								currentToolIndex={appState.currentToolIndex}
								pendingQuestion={appState.pendingQuestion}
								onQuestionAnswer={handleQuestionAnswer}
								mcpInitialized={appState.mcpInitialized}
								client={appState.client}
								customCommands={Array.from(
									appState.customCommandCache.entries(),
								).map(([name, command]) => ({
									name,
									description: command.metadata.description,
								}))}
								inputDisabled={false}
								onSubmittedDraft={handleSubmittedDraft}
								restoreSubmittedDraft={restoredDraft}
								queuedMessages={userMessageQueue.queuedMessages}
								onQueueMessage={userMessageQueue.enqueueMessage}
								onRemoveQueuedMessage={userMessageQueue.removeMessage}
								isBusy={cancellable}
								developmentMode={appState.developmentMode}
								contextPercentUsed={appState.contextPercentUsed}
								contextSource={appState.contextSource}
								sessionName={appState.sessionName || undefined}
								compactToolDisplay={appState.compactToolDisplay}
								liveTaskList={appState.liveTaskList}
								onToggleCompactDisplay={handleToggleCompactDisplay}
								pendingSubagentApproval={pendingSubagentApproval}
								onSubagentToolApproval={handleSubagentToolApproval}
								pendingToolConfirmation={pendingToolConfirmation}
								onToolConfirmation={handleToolConfirmation}
								onSubmit={handleUserSubmit}
								activeEditor={vscodeServer.activeEditor}
								onDismissActiveEditor={vscodeServer.dismissActiveEditor}
								onToggleMode={appHandlers.handleToggleDevelopmentMode}
								onToggleReasoningExpanded={handleToggleReasoningExpanded}
								tune={appState.tune}
								currentModel={appState.currentModel}
								statusInfo={statusInfo}
								statusLineSlot={statusLineSlot}
							/>
						</UIStateProvider>
					)}
			</Box>
		</Box>
	);
}
