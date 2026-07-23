import {Box, Text, useFocus, useInput} from 'ink';
import Spinner from 'ink-spinner';
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import {commandRegistry} from '@/commands';
import {AnimatedGear, ElapsedTimer} from '@/components/animated-gear-timer';
import {
	DevelopmentModeIndicator,
	type DevelopmentModeStatusInfo,
} from '@/components/development-mode-indicator';
import TextInput from '@/components/text-input';
import {getShowWorkingIndicator} from '@/config/preferences';
import {getTextboxBackground} from '@/config/themes';
import {useInputState} from '@/hooks/useInputState';
import {useResponsiveTerminal} from '@/hooks/useTerminalWidth';
import {useTheme} from '@/hooks/useTheme';
import {useUIStateContext} from '@/hooks/useUIState';

import type {
	QueuedUserMessage,
	UserMessageQueueDraft,
} from '@/hooks/useUserMessageQueue';
import {promptHistory} from '@/prompt-history';
import type {TuneConfig} from '@/types/config';
import type {
	ContextSource,
	DevelopmentMode,
	ImageAttachment,
} from '@/types/core';
import type {
	InputState,
	RestoredInputDraft,
	SubmittedInputDraft,
} from '@/types/hooks';
import {Completion, CustomCommandCompletionSource} from '@/types/index';
import type {Colors} from '@/types/ui';
import {
	extractImageReferences,
	readClipboardImage,
	readImageFile,
} from '@/utils/clipboard-image';
import {
	getCurrentFileMention,
	getFileCompletions,
} from '@/utils/file-autocomplete';
import {handleFileMention} from '@/utils/file-mention-handler';
import {
	assemblePrompt,
	expandPastePlaceholdersForDisplay,
} from '@/utils/prompt-processor';
import {getVisualLineSegments} from '@/utils/text-wrapping';
import type {ActiveEditorState} from '@/vscode/vscode-server';

const MAX_COMMAND_COMPLETION_ROWS = 10;

interface ChatProps {
	onSubmit?: (
		message: string,
		displayValue: string,
		images?: ImageAttachment[],
	) => void;
	onQueueMessage?: (message: UserMessageQueueDraft) => void;
	queuedMessages?: QueuedUserMessage[];
	onRemoveQueuedMessage?: (id: string) => void;
	placeholder?: string;
	customCommands?: CustomCommandCompletionSource[]; // Custom command names/aliases with descriptions
	disabled?: boolean; // Disable input when AI is processing
	isBusy?: boolean; // True when in-flight work is cancellable; Escape is owned by the global handler, so it must not clear the input
	onToggleMode?: () => void; // Callback when user presses shift+tab to toggle development mode
	onToggleReasoningExpanded?: () => void; // Callback when user presses ctrl+r to toggle expanded reasoning traces
	onToggleCompactDisplay?: () => void; // Callback when user presses ctrl+o to toggle compact tool display
	compactToolDisplay?: boolean; // Current compact display state
	developmentMode?: DevelopmentMode; // Current development mode
	contextPercentUsed?: number | null; // Context window usage percentage
	contextSource?: ContextSource | null; // Whether ctx % is API-reported or estimated
	sessionName?: string; // Optional session name for display
	tune?: TuneConfig; // Model mode configuration
	currentModel?: string; // Active model id — resolves the 'auto' tune profile for display
	statusInfo?: DevelopmentModeStatusInfo;
	statusLineSlot?: ReactNode;
	activeEditor?: ActiveEditorState | null; // VS Code active file + optional selection
	onDismissActiveEditor?: () => void; // Dismiss the active editor pill on clear/escape
	forceFocus?: boolean; // Force focus for testing (bypasses useFocus)
	onSubmittedDraft?: (draft: SubmittedInputDraft) => void;
	restoreSubmittedDraft?: RestoredInputDraft | null;
}

export default function UserInput({
	onSubmit,
	onQueueMessage,
	queuedMessages = [],
	onRemoveQueuedMessage,
	placeholder,
	customCommands = [],
	disabled = false,
	isBusy = false,
	onToggleMode,
	onToggleReasoningExpanded,
	onToggleCompactDisplay,
	compactToolDisplay = true,
	developmentMode = 'normal',
	contextPercentUsed,
	contextSource,
	sessionName,
	tune,
	currentModel,
	statusInfo,
	statusLineSlot,
	activeEditor,
	onDismissActiveEditor,
	forceFocus = false,
	onSubmittedDraft,
	restoreSubmittedDraft = null,
}: ChatProps) {
	const {isFocused, focus} = useFocus({autoFocus: !disabled, id: 'user-input'});

	// Track when busy state starts for the working indicator timer
	const [workingStartTime, setWorkingStartTime] = useState<number | null>(null);

	useEffect(() => {
		if (isBusy && getShowWorkingIndicator()) {
			setWorkingStartTime(Date.now());
		} else {
			setWorkingStartTime(null);
		}
	}, [isBusy]);

	const effectiveFocus = forceFocus || isFocused;
	const {colors} = useTheme();
	const inputState = useInputState();
	const uiState = useUIStateContext();
	const {boxWidth, isNarrow, actualWidth, truncate} = useResponsiveTerminal();
	// boxWidth floors at 40, which exceeds the real width of terminals narrower
	// than ~44 columns. Rows wider than the terminal hard-wrap in the terminal
	// itself, which breaks Ink's newline-based erase accounting and leaves
	// residue rows that composite over later frames (the garbled multi-line
	// echo on submit). Cap the promptChar textbox at the true terminal width;
	// at columns >= 44 this equals boxWidth exactly, so normal-width rendering
	// is unchanged. Classic themes keep raw boxWidth untouched.
	const arrowBoxWidth = Math.max(20, Math.min(boxWidth, actualWidth - 2));
	// Must match the wrapWidth passed to TextInput below — both sides use it to
	// decide whether Up/Down means line navigation or history.
	// Themes with a promptChar render a rounded, inset box and keep the "❯ "
	// prefix visible while typing: side margins (2) + rounded border (2) +
	// paddingX (2) + prefix (2). Classic style: left border (1) + padding (2).
	const inputWrapWidth = colors.promptChar ? arrowBoxWidth - 8 : boxWidth - 3;
	const [textInputKey, setTextInputKey] = useState(0);
	const completionJustSelectedRef = useRef(false);
	// Escape-dismissed guard: re-armed on the next input change so the auto-show
	// effect doesn't immediately re-open a menu the user just dismissed.
	const completionsDismissedRef = useRef(false);
	// Store the full InputState draft when starting history navigation, so it can be restored
	const savedDraftRef = useRef<InputState>({
		displayValue: '',
		placeholderContent: {},
	});
	// File autocomplete state
	const [isFileAutocompleteMode, setIsFileAutocompleteMode] = useState(false);
	const [fileCompletions, setFileCompletions] = useState<
		Array<{path: string; score: number}>
	>([]);
	const [selectedFileIndex, setSelectedFileIndex] = useState(0);
	const [selectedQueuedIndex, setSelectedQueuedIndex] = useState(-1);
	// Pending image attachments sent with the next submitted message.
	const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
	const lastRestoredDraftIdRef = useRef<number | null>(null);

	const {
		input,
		historyIndex,
		setOriginalInput,
		setHistoryIndex,
		updateInput,
		resetInput,
		deletePlaceholder: _deletePlaceholder,
		currentState,
		setInputState,
	} = inputState;

	const {
		showClearMessage,
		showCompletions,
		completions,
		pendingFileMentions,
		selectedCompletionIndex,
		setShowClearMessage,
		setShowCompletions,
		setCompletions,
		setPendingFileMentions,
		setSelectedCompletionIndex,
		resetUIState,
	} = uiState;

	// Check if we're in bash mode (input starts with !)
	const isBashMode = input.trim().startsWith('!');

	// Check if we're in command mode (input starts with /)
	const isCommandMode = input.trim().startsWith('/');

	// Load history on mount
	useEffect(() => {
		void promptHistory.loadHistory();
	}, []);

	useEffect(() => {
		if (
			!restoreSubmittedDraft ||
			lastRestoredDraftIdRef.current === restoreSubmittedDraft.id
		) {
			return;
		}

		lastRestoredDraftIdRef.current = restoreSubmittedDraft.id;
		setInputState({
			displayValue: restoreSubmittedDraft.inputState.displayValue,
			placeholderContent: {
				...restoreSubmittedDraft.inputState.placeholderContent,
			},
		});
		setAttachments([...restoreSubmittedDraft.attachments]);
		resetUIState();
		promptHistory.resetIndex();
		setTextInputKey(prev => prev + 1);
		focus('user-input');
	}, [restoreSubmittedDraft, setInputState, resetUIState, focus]);

	useEffect(() => {
		if (queuedMessages.length === 0) {
			setSelectedQueuedIndex(-1);
			return;
		}

		setSelectedQueuedIndex(index =>
			index >= queuedMessages.length ? queuedMessages.length - 1 : index,
		);
	}, [queuedMessages.length]);

	// When in-flight work ends, reclaim focus so the cursor returns and the user
	// can type right away. Focus can be dropped mid-turn (e.g. an interstitial
	// tool-confirmation prompt unmounts the input), and useFocus autoFocus only
	// fires on mount, so we restore it on the busy -> idle edge.
	const wasBusyRef = useRef(isBusy);
	useEffect(() => {
		if (wasBusyRef.current && !isBusy && !disabled) {
			focus('user-input');
		}
		wasBusyRef.current = isBusy;
	}, [isBusy, disabled, focus]);

	// Consume pending file mentions from explorer and insert into input
	// Properly attach files by calling handleFileMention for each
	useEffect(() => {
		if (pendingFileMentions.length === 0) return;

		const attachFiles = async () => {
			let state = currentState;
			let displayValue = state.displayValue;

			for (const filePath of pendingFileMentions) {
				// Create a temporary mention text to replace
				const mentionText = `@${filePath}`;
				// Add the mention to display value first
				displayValue = displayValue
					? `${displayValue} ${mentionText}`
					: mentionText;

				// Handle the file mention to create placeholder
				const result = await handleFileMention(
					filePath,
					displayValue,
					state.placeholderContent,
					mentionText,
				);

				if (result) {
					state = result;
					displayValue = result.displayValue;
				}
			}

			setInputState(state);
			setTextInputKey(prev => prev + 1);
			setPendingFileMentions([]);
		};

		void attachFiles();
	}, [
		pendingFileMentions,
		currentState,
		setInputState,
		setPendingFileMentions,
	]);

	// Trigger file autocomplete when input changes
	useEffect(() => {
		const runFileAutocomplete = async () => {
			const mention = getCurrentFileMention(input, input.length);

			if (mention) {
				setIsFileAutocompleteMode(true);
				const cwd = process.cwd();
				const completions = await getFileCompletions(mention.mention, cwd);
				setFileCompletions(completions);
				setSelectedFileIndex(0); // Reset selection when completions change
			} else {
				setIsFileAutocompleteMode(false);
				setFileCompletions([]);
				setSelectedFileIndex(0);
			}
		};

		void runFileAutocomplete();
	}, [input]);

	// Calculate command completions using useMemo to prevent flashing
	const commandCompletions = useMemo(() => {
		if (!isCommandMode || isFileAutocompleteMode) {
			return [];
		}

		// Once the user types a space, they're entering arguments for the
		// command (e.g. `/model gpt-4`). Stop offering completions so Enter
		// submits the command-with-args instead of selecting a completion and
		// dropping everything after the command name.
		if (input.slice(1).includes(' ')) {
			return [];
		}

		const commandPrefix = input.slice(1).split(' ')[0];

		const builtInCompletions = commandRegistry.getCompletions(commandPrefix);
		const customCompletions = customCommands
			.filter(cmd => {
				// Include all when no prefix, otherwise filter by prefix
				return (
					!commandPrefix ||
					cmd.name.toLowerCase().includes(commandPrefix.toLowerCase())
				);
			})
			.sort((a, b) => a.name.localeCompare(b.name));

		return [
			...builtInCompletions.map(cmd => ({
				name: cmd,
				isCustom: false,
				description: commandRegistry.get(cmd)?.description,
			})),
			...customCompletions.map(cmd => ({
				name: cmd.name,
				isCustom: true,
				description: cmd.description,
			})),
		] as Completion[];
	}, [input, isCommandMode, isFileAutocompleteMode, customCommands]);

	// Re-arm auto-show on every input change, so an Escape-dismiss lasts only
	// until the next keystroke.
	useEffect(() => {
		completionsDismissedRef.current = false;
	}, [input]);

	// Update UI state for command completions
	useEffect(() => {
		if (completionJustSelectedRef.current) {
			completionJustSelectedRef.current = false;
			return;
		}
		if (commandCompletions.length > 0) {
			setCompletions(commandCompletions);
			// Show the menu as soon as completions exist (typing `/`), not only on
			// Tab — unless the user just dismissed it with Escape for this input.
			if (!completionsDismissedRef.current) {
				setShowCompletions(true);
			}
			setSelectedCompletionIndex(prev =>
				prev >= commandCompletions.length
					? commandCompletions.length - 1
					: prev < 0
						? 0
						: prev,
			);
		} else if (showCompletions) {
			setCompletions([]);
			setShowCompletions(false);
			setSelectedCompletionIndex(-1);
		}
	}, [
		commandCompletions,
		showCompletions,
		setCompletions,
		setShowCompletions,
		setSelectedCompletionIndex,
	]);

	// Helper functions

	// Handle file mention selection (Tab key in file autocomplete mode)
	const handleFileSelection = useCallback(async () => {
		if (!isFileAutocompleteMode || fileCompletions.length === 0) {
			return false;
		}

		const mention = getCurrentFileMention(input, input.length);
		if (!mention) {
			return false;
		}

		// Select the currently highlighted file
		const selectedPath = fileCompletions[selectedFileIndex]?.path;
		if (!selectedPath) {
			return false;
		}

		// Extract the original mention text (the @... part we're replacing)
		const mentionText = input.substring(mention.startIndex, mention.endIndex);

		// Handle the file mention to create placeholder
		const result = await handleFileMention(
			selectedPath,
			currentState.displayValue,
			currentState.placeholderContent,
			mentionText,
		);

		if (result) {
			setInputState(result);
			setIsFileAutocompleteMode(false);
			setFileCompletions([]);
			setSelectedFileIndex(0);
			setTextInputKey(prev => prev + 1);
			return true;
		}

		return false;
	}, [
		isFileAutocompleteMode,
		fileCompletions,
		selectedFileIndex,
		input,
		currentState,
		setInputState,
	]);

	// Attach an image to the pending message. We never gate on a model-capability
	// heuristic here: if the model can't see images it will say so or error, which
	// is clearer than an over-cautious warning on every attach.
	const attachImage = useCallback((image: ImageAttachment) => {
		setAttachments(prev => [...prev, image]);
	}, []);

	// Handle form submission
	const handleSubmit = useCallback(() => {
		if (!onSubmit && !onQueueMessage) return;

		let images = attachments;
		let assembled = assemblePrompt(currentState);
		// Chat history shows the real pasted text, not the [Paste #N] placeholder
		let display = expandPastePlaceholdersForDisplay(currentState);

		// Image file paths the user typed, pasted, or dragged into the terminal
		// (often quoted, mixed in with prose) become attachments; the literal
		// path in the message text is replaced with an `[Image #N]` placeholder,
		// numbered after any attachments already added via Ctrl+V.
		const {text: cleanedAssembled, paths} = extractImageReferences(
			assembled,
			attachments.length,
		);
		if (paths.length > 0) {
			const dropped = paths
				.map(readImageFile)
				.filter((img): img is ImageAttachment => img !== null);
			if (dropped.length > 0) {
				images = [...attachments, ...dropped];
				assembled = cleanedAssembled;
				display = extractImageReferences(display, attachments.length).text;
			}
		}

		// Nothing to send: no text and no attachments.
		if (!assembled.trim() && images.length === 0) return;

		const inputStateForHistory: InputState = {
			displayValue: currentState.displayValue,
			placeholderContent: {...currentState.placeholderContent},
		};

		if (isBusy && !assembled.trim().startsWith('/') && onQueueMessage) {
			promptHistory.addPrompt(inputStateForHistory);
			onQueueMessage({
				message: assembled,
				displayValue: display,
				images: images.length > 0 ? images : undefined,
				inputState: inputStateForHistory,
			});
			resetInput();
			resetUIState();
			setAttachments([]);
			promptHistory.resetIndex();
			setSelectedQueuedIndex(-1);
			return;
		}

		if (!onSubmit) return;

		// Save the InputState to history and send assembled message to AI
		promptHistory.addPrompt(inputStateForHistory);
		onSubmittedDraft?.({
			inputState: inputStateForHistory,
			attachments: images,
		});
		onSubmit(assembled, display, images.length > 0 ? images : undefined);
		resetInput();
		resetUIState();
		setAttachments([]);
		promptHistory.resetIndex();
		setSelectedQueuedIndex(-1);
	}, [
		attachments,
		onSubmit,
		onQueueMessage,
		resetInput,
		resetUIState,
		currentState,
		isBusy,
		onSubmittedDraft,
	]);

	// Handle escape key logic
	const handleEscape = useCallback(() => {
		if (showCompletions) {
			setShowCompletions(false);
			setSelectedCompletionIndex(-1);
			completionsDismissedRef.current = true;
			return;
		}
		if (isFileAutocompleteMode) {
			setIsFileAutocompleteMode(false);
			setFileCompletions([]);
			return;
		}
		if (showClearMessage) {
			resetInput();
			resetUIState();
			setAttachments([]);
			onDismissActiveEditor?.();
			focus('user-input');
		} else {
			setShowClearMessage(true);
		}
	}, [
		showCompletions,
		isFileAutocompleteMode,
		showClearMessage,
		setShowCompletions,
		setSelectedCompletionIndex,
		resetInput,
		resetUIState,
		onDismissActiveEditor,
		setShowClearMessage,
		focus,
	]);

	// History navigation
	const handleHistoryNavigation = useCallback(
		(direction: 'up' | 'down') => {
			const history = promptHistory.getHistory();
			if (history.length === 0) return;

			if (direction === 'up') {
				if (historyIndex === -1) {
					// Save the full current state before starting navigation
					savedDraftRef.current = currentState;
					setOriginalInput(input);
					setHistoryIndex(history.length - 1);
					setInputState(history[history.length - 1]);
					setTextInputKey(prev => prev + 1);
				} else if (historyIndex > 0) {
					const newIndex = historyIndex - 1;
					setHistoryIndex(newIndex);
					setInputState(history[newIndex]);
					setTextInputKey(prev => prev + 1);
				} else if (historyIndex === 0) {
					// At first history item, restore saved draft
					setHistoryIndex(-2);
					setInputState(savedDraftRef.current);
					setTextInputKey(prev => prev + 1);
				} else if (historyIndex === -2) {
					// At draft, cycle back to last history item
					savedDraftRef.current = currentState;
					setHistoryIndex(history.length - 1);
					setInputState(history[history.length - 1]);
					setTextInputKey(prev => prev + 1);
				}
			} else {
				if (historyIndex === -1) {
					// Save draft, go to draft cycling state (visually a no-op)
					savedDraftRef.current = currentState;
					setOriginalInput(input);
					setHistoryIndex(-2);
					setInputState(savedDraftRef.current);
					setTextInputKey(prev => prev + 1);
				} else if (historyIndex === -2) {
					// At draft, cycle to first history item
					savedDraftRef.current = currentState;
					setHistoryIndex(0);
					setInputState(history[0]);
					setTextInputKey(prev => prev + 1);
				} else if (historyIndex >= 0 && historyIndex < history.length - 1) {
					// Move forward in history
					const newIndex = historyIndex + 1;
					setHistoryIndex(newIndex);
					setInputState(history[newIndex]);
					setTextInputKey(prev => prev + 1);
				} else if (historyIndex === history.length - 1) {
					// At last history item, restore saved draft
					setHistoryIndex(-2);
					setInputState(savedDraftRef.current);
					setTextInputKey(prev => prev + 1);
				}
			}
		},
		[
			historyIndex,
			input,
			currentState,
			setHistoryIndex,
			setOriginalInput,
			setInputState,
		],
	);

	const handleQueueNavigation = useCallback(
		(direction: 'up' | 'down') => {
			if (!isBusy || input.length > 0 || queuedMessages.length === 0) {
				return false;
			}

			if (direction === 'up') {
				// At the input (-1) there's nothing above the queue, so let the press
				// fall through to history navigation. From the first queued item, step
				// back up to the input.
				if (selectedQueuedIndex < 0) {
					return false;
				}
				setSelectedQueuedIndex(selectedQueuedIndex - 1);
				return true;
			}

			// Down enters the queue from the input, then walks toward the last item
			// and stops there (no wrap-around).
			if (selectedQueuedIndex >= queuedMessages.length - 1) {
				return selectedQueuedIndex >= 0;
			}
			setSelectedQueuedIndex(selectedQueuedIndex + 1);
			return true;
		},
		[isBusy, input.length, queuedMessages.length, selectedQueuedIndex],
	);

	const loadSelectedQueuedMessage = useCallback(() => {
		if (
			!isBusy ||
			input.length > 0 ||
			selectedQueuedIndex < 0 ||
			selectedQueuedIndex >= queuedMessages.length
		) {
			return false;
		}

		const queuedMessage = queuedMessages[selectedQueuedIndex];
		setInputState(
			queuedMessage.inputState ?? {
				displayValue: queuedMessage.displayValue,
				placeholderContent: {},
			},
		);
		setAttachments(queuedMessage.images ?? []);
		onRemoveQueuedMessage?.(queuedMessage.id);
		setSelectedQueuedIndex(-1);
		setTextInputKey(prev => prev + 1);
		return true;
	}, [
		isBusy,
		input.length,
		selectedQueuedIndex,
		queuedMessages,
		setInputState,
		onRemoveQueuedMessage,
	]);

	const removeSelectedQueuedMessage = useCallback(() => {
		if (
			!isBusy ||
			input.length > 0 ||
			selectedQueuedIndex < 0 ||
			selectedQueuedIndex >= queuedMessages.length
		) {
			return false;
		}

		onRemoveQueuedMessage?.(queuedMessages[selectedQueuedIndex].id);
		setSelectedQueuedIndex(index =>
			index >= queuedMessages.length - 1 ? queuedMessages.length - 2 : index,
		);
		return true;
	}, [
		isBusy,
		input.length,
		selectedQueuedIndex,
		queuedMessages,
		onRemoveQueuedMessage,
	]);

	useInput((inputChar, key) => {
		// Cancelling in-flight work is owned by the single section-level Escape
		// handler (see InteractiveApp), which fires no matter which component is
		// mounted. Here we only swallow Escape while busy so it doesn't fall
		// through to the clear-input double-press.
		if (key.escape && (isBusy || disabled)) {
			return;
		}

		// Handle shift+tab to toggle development mode (always available)
		if (key.tab && key.shift && onToggleMode) {
			onToggleMode();
			return;
		}

		// Handle ctrl+o to toggle compact tool display (always available)
		if (key.ctrl && inputChar === 'o' && onToggleCompactDisplay) {
			onToggleCompactDisplay();
			return;
		}

		// Handle ctrl+r to toggle expanded reasoning traces (always available)
		if (key.ctrl && inputChar === 'r' && onToggleReasoningExpanded) {
			onToggleReasoningExpanded();
			return;
		}

		// Delete/Backspace removes the highlighted queued message. Safe to bind
		// bare: removeSelectedQueuedMessage no-ops unless a queued item is selected
		// and the input is empty, so normal backspace-to-edit still falls through.
		if ((key.delete || key.backspace) && removeSelectedQueuedMessage()) {
			return;
		}

		// Block all other input when disabled
		if (disabled) {
			return;
		}

		// Ctrl+V: pull an image off the system clipboard as an attachment.
		// Terminal paste of regular text arrives as a bracketed paste, not as
		// Ctrl+V, so this binding is free to mean "paste image".
		if (key.ctrl && inputChar === 'v') {
			const image = readClipboardImage();
			if (image) {
				attachImage(image);
			}
			return;
		}

		// Ctrl+X: drop the most recently added image attachment.
		if (key.ctrl && inputChar === 'x') {
			setAttachments(prev => prev.slice(0, -1));
			return;
		}

		// Handle special keys
		if (key.escape) {
			handleEscape();
			return;
		}

		// Handle Tab key
		if (key.tab) {
			// File autocomplete takes priority
			if (isFileAutocompleteMode) {
				void handleFileSelection();
				return;
			}

			// Command completion - use pre-calculated commandCompletions
			if (input.startsWith('/')) {
				// Tab selects the highlighted suggestion when the menu is open. #696 made
				// completion Tab-triggered, but that often failed to render the menu
				// (especially in alt-screen); show-on-`/` + Tab-to-select is more reliable.
				if (showCompletions && completions.length > 0) {
					const selected =
						completions[
							selectedCompletionIndex >= 0 ? selectedCompletionIndex : 0
						];
					const completedText = `/${selected.name}`;
					completionJustSelectedRef.current = true;
					setInputState({
						displayValue: completedText,
						placeholderContent: {},
					});
					setShowCompletions(false);
					setSelectedCompletionIndex(-1);
					setTextInputKey(prev => prev + 1);
					return;
				}
				if (commandCompletions.length === 1) {
					// Auto-complete when there's exactly one match
					const completion = commandCompletions[0];
					const completedText = `/${completion.name}`;
					// Use setInputState to bypass paste detection for autocomplete
					setInputState({
						displayValue: completedText,
						placeholderContent: currentState.placeholderContent,
					});
					setTextInputKey(prev => prev + 1);
				} else if (commandCompletions.length > 1) {
					// Show completions when there are multiple matches
					setCompletions(commandCompletions);
					setShowCompletions(true);
					setSelectedCompletionIndex(0);
				}
				return;
			}
		}

		// Space exits file autocomplete mode
		if (inputChar === ' ' && isFileAutocompleteMode) {
			setIsFileAutocompleteMode(false);
			setFileCompletions([]);
		}

		// Clear clear message on other input
		if (showClearMessage) {
			setShowClearMessage(false);
			focus('user-input');
		}

		// Handle return keys for multiline input
		// Ctrl+J is the official newline shortcut and reliably sends a literal LF
		if (
			(key.ctrl && inputChar === 'j') ||
			(inputChar === '\n' && !key.return)
		) {
			updateInput(input + '\n');
			return;
		}

		// Support Shift+Enter if the terminal sends it properly
		if (key.return && key.shift) {
			updateInput(input + '\n');
			return;
		}

		// Handle Enter to select completion
		if (
			key.return &&
			!key.shift &&
			showCompletions &&
			completions.length > 0 &&
			selectedCompletionIndex >= 0
		) {
			const selected = completions[selectedCompletionIndex];
			const completedText = `/${selected.name}`;
			completionJustSelectedRef.current = true;
			setInputState({
				displayValue: completedText,
				placeholderContent: {},
			});
			setShowCompletions(false);
			setSelectedCompletionIndex(-1);
			setTextInputKey(prev => prev + 1);
			return;
		}

		// Handle Enter to submit (fallthrough - if completion handler didn't return)
		if (key.return && !key.shift) {
			if (loadSelectedQueuedMessage()) {
				return;
			}
			handleSubmit();
			return;
		}

		// Handle navigation
		if (key.upArrow) {
			// In multiline mode (real \n or soft-wrapped visual lines), Up/Down
			// navigate lines — let TextInput handle it
			if (getVisualLineSegments(input, inputWrapWidth).length > 1) return;
			// File autocomplete navigation takes priority
			if (isFileAutocompleteMode && fileCompletions.length > 0) {
				setSelectedFileIndex(prev =>
					prev > 0 ? prev - 1 : fileCompletions.length - 1,
				);
				return;
			}
			// Command completion navigation takes priority over history
			if (showCompletions && completions.length > 0) {
				setSelectedCompletionIndex(prev =>
					prev > 0 ? prev - 1 : completions.length - 1,
				);
				return;
			}
			if (handleQueueNavigation('up')) {
				return;
			}
			handleHistoryNavigation('up');
			return;
		}

		if (key.downArrow) {
			// In multiline mode (real \n or soft-wrapped visual lines), Up/Down
			// navigate lines — let TextInput handle it
			if (getVisualLineSegments(input, inputWrapWidth).length > 1) return;
			// File autocomplete navigation takes priority
			if (isFileAutocompleteMode && fileCompletions.length > 0) {
				setSelectedFileIndex(prev =>
					prev < fileCompletions.length - 1 ? prev + 1 : 0,
				);
				return;
			}
			// Command completion navigation takes priority over history
			if (showCompletions && completions.length > 0) {
				setSelectedCompletionIndex(prev =>
					prev < completions.length - 1 ? prev + 1 : 0,
				);
				return;
			}
			if (handleQueueNavigation('down')) {
				return;
			}
			handleHistoryNavigation('down');
			return;
		}
	});

	const textColor = disabled || !input ? colors.secondary : colors.primary;
	const formatQueuedMessage = (message: QueuedUserMessage) => {
		const imageSuffix =
			message.images && message.images.length > 0
				? ` (${message.images.length} image${message.images.length === 1 ? '' : 's'})`
				: '';
		const singleLine = message.displayValue.replace(/\s+/g, ' ').trim();
		// Truncate against the true terminal width like tool result rows do, not
		// boxWidth (which floors at 40 and would overflow narrow terminals). The
		// overhead covers the box border + padding (2), the '▸ '/'  ' marker (2),
		// and a right-edge safety margin.
		const maxLength = Math.max(8, actualWidth - imageSuffix.length - 6);
		const text = truncate(singleLine, maxLength);
		return `${text}${imageSuffix}`;
	};
	const commandCompletionWindow = useMemo(() => {
		if (completions.length <= MAX_COMMAND_COMPLETION_ROWS) {
			return {start: 0, end: completions.length, items: completions};
		}

		const selectedIndex =
			selectedCompletionIndex >= 0 ? selectedCompletionIndex : 0;
		const centeredStart =
			selectedIndex - Math.floor(MAX_COMMAND_COMPLETION_ROWS / 2);
		const maxStart = completions.length - MAX_COMMAND_COMPLETION_ROWS;
		const start = Math.min(Math.max(centeredStart, 0), maxStart);
		const end = start + MAX_COMMAND_COMPLETION_ROWS;

		return {start, end, items: completions.slice(start, end)};
	}, [completions, selectedCompletionIndex]);
	const slashCommandNames = useMemo(
		() => [
			...commandRegistry.getAll().map(command => command.name),
			...customCommands.map(command => command.name),
		],
		[customCommands],
	);

	// Shared name-column width so every visible row's description starts at
	// the same offset, like openclaude's completion menu. Sized off the full
	// completions list (not just the current window) so the column doesn't
	// jump around as the user arrows through a scrolled list.
	//
	// The completion rows render INSIDE the input Box's content area, so the
	// budget must match THAT box's interior width, not the raw terminal
	// columns (actualWidth) — using actualWidth overestimates the available
	// space by exactly the border/padding/margin overhead below, which is
	// what let long rows wrap under icon themes. Mirrors the inputWrapWidth /
	// user-message.tsx textWidth derivation, minus the "❯ " prefix term those
	// use (completion rows have their own '▸ '/'/' marker instead):
	//   promptChar: width={boxWidth - 2} (side margins already reserved) minus
	//     rounded border (2) minus paddingX (2) = boxWidth - 6.
	//   classic: width={boxWidth} minus left border only (1) minus paddingX
	//     (2) = boxWidth - 3.
	const completionInteriorWidth = (colors as Colors & {promptChar?: string})
		.promptChar
		? arrowBoxWidth - 6
		: boxWidth - 3;
	const commandCompletionAvailableWidth = Math.max(20, completionInteriorWidth);
	const commandNameColumnWidth = useMemo(() => {
		const longestName = completions.reduce(
			(max, item) => Math.max(max, item.name.length),
			0,
		);
		return Math.min(
			longestName + 2,
			Math.floor(commandCompletionAvailableWidth * 0.4),
		);
	}, [completions, commandCompletionAvailableWidth]);
	const modelInputBadge =
		colors.promptChar && currentModel
			? truncate(currentModel, Math.max(8, inputWrapWidth - 4))
			: '';

	// When disabled, show minimal UI to avoid cluttering the screen
	if (disabled) {
		return (
			<Box flexDirection="column" paddingY={1} width="100%" marginTop={1}>
				<Text color={colors.secondary}>
					<Spinner type="dots" /> Press Esc to cancel
					{onToggleCompactDisplay && (
						<Text>
							{' '}
							· ctrl-o {compactToolDisplay ? 'expand' : 'compact'}{' '}
							{isNarrow ? '' : 'tool results'}
						</Text>
					)}
				</Text>
				<DevelopmentModeIndicator
					developmentMode={developmentMode}
					colors={colors}
					contextPercentUsed={contextPercentUsed ?? null}
					contextSource={contextSource ?? null}
					sessionName={sessionName}
					tune={tune}
					currentModel={currentModel}
					statusInfo={statusInfo}
				/>
				{statusLineSlot}
			</Box>
		);
	}

	// Queued-messages list. Icon themes (omnicode) render it ABOVE the input
	// box; classic themes keep it inside the box below the input row.
	const queuedBlock = queuedMessages.length > 0 && (
		<Box flexDirection="column" marginTop={1}>
			<Text color={colors.secondary}>
				Queued messages (↑/↓ select, Enter edit, Del remove):
			</Text>
			{queuedMessages.map((message, index) => {
				const isSelected = index === selectedQueuedIndex;
				return (
					<Text
						key={message.id}
						color={isSelected ? colors.info : colors.primary}
						bold={isSelected}
					>
						{isSelected ? '▸ ' : '  '}
						{formatQueuedMessage(message)}
					</Text>
				);
			})}
		</Box>
	);

	return (
		<>
			{!isBashMode ? (
				<Box marginTop={1}>
					{isBusy && getShowWorkingIndicator() ? (
						<Box>
							<Text color={colors.primary}>
								<AnimatedGear />
							</Text>
							<Text color={colors.primary} bold>
								{' Working'}
							</Text>
							<Text color={colors.primary}>
								<Spinner type="simpleDots" />
							</Text>
							{workingStartTime && (
								<ElapsedTimer startTime={workingStartTime} />
							)}
						</Box>
					) : colors.assistantIcon ? (
						<Text>
							<Text color={colors.secondary}>{colors.assistantIcon} </Text>
							<Text color={colors.primary}>
								What would you like me to help with?
							</Text>
						</Text>
					) : (
						<Text color={colors.primary} bold>
							What would you like me to help with?
						</Text>
					)}
				</Box>
			) : (
				<Text color={colors.tool} bold>
					Bash mode
				</Text>
			)}

			{Boolean(colors.promptChar) && queuedBlock && (
				<Box marginX={1} flexDirection="column">
					{queuedBlock}
				</Box>
			)}

			<Box
				flexDirection="column"
				marginTop={colors.promptChar ? 0 : 1}
				backgroundColor={getTextboxBackground(colors)}
				width={colors.promptChar ? arrowBoxWidth - 2 : boxWidth}
				marginX={colors.promptChar ? 1 : 0}
				paddingX={1}
				paddingY={colors.promptChar ? 0 : 1}
				borderStyle={colors.promptChar ? 'round' : 'bold'}
				borderLeft={true}
				borderRight={Boolean(colors.promptChar)}
				borderTop={Boolean(colors.promptChar)}
				borderBottom={Boolean(colors.promptChar)}
				borderColor={
					colors.promptChar
						? isBashMode
							? colors.tool
							: colors.secondary
						: undefined
				}
				borderLeftColor={
					colors.promptChar
						? undefined
						: isBashMode
							? colors.tool
							: colors.primary
				}
			>
				{/* Input row */}
				<Box>
					{(input.length === 0 || Boolean(colors.promptChar)) && (
						<Text
							color={
								isBashMode
									? colors.tool
									: colors.promptChar
										? colors.primary
										: textColor
							}
							bold={Boolean(colors.promptChar)}
						>
							{colors.promptChar ?? '>'}{' '}
						</Text>
					)}
					<TextInput
						key={textInputKey}
						value={input}
						onChange={updateInput}
						onEdgeArrow={handleHistoryNavigation}
						onSubmit={handleSubmit}
						onEnter={handleSubmit}
						placeholder="/ commands, ! bash, ↑/↓ history"
						focus={effectiveFocus}
						wrapWidth={inputWrapWidth}
						handleEnter={false}
						slashCommandColor={colors.info}
						slashCommandNames={slashCommandNames}
					/>
				</Box>

				{showClearMessage && (
					<Text color={colors.secondary}>Press escape again to clear</Text>
				)}

				{showCompletions && completions.length > 0 && (
					<Box flexDirection="column" marginTop={1}>
						<Text color={colors.secondary}>Available commands:</Text>
						{commandCompletionWindow.items.map((completion, index) => {
							const completionIndex = commandCompletionWindow.start + index;
							const isSelected = completionIndex === selectedCompletionIndex;
							const marker = isSelected ? '▸ ' : '  ';
							const paddedName = completion.name.padEnd(commandNameColumnWidth);
							// Never wraps to a second line: truncate the description to
							// whatever width remains after the marker, '/', and name column.
							const descriptionText =
								!isNarrow && completion.description
									? truncate(
											completion.description,
											Math.max(
												0,
												commandCompletionAvailableWidth -
													marker.length -
													1 -
													paddedName.length -
													1,
											),
										)
									: '';
							return (
								<Text
									key={`${completion.isCustom ? 'custom' : 'built-in'}-${completion.name}`}
									wrap="truncate"
								>
									<Text
										color={isSelected ? colors.info : colors.secondary}
										bold={isSelected}
									>
										{marker}/{paddedName}
									</Text>
									{descriptionText && (
										<Text color={colors.secondary}> {descriptionText}</Text>
									)}
								</Text>
							);
						})}
						{completions.length > MAX_COMMAND_COMPLETION_ROWS && (
							<Text color={colors.secondary}>
								Showing {commandCompletionWindow.start + 1}-
								{commandCompletionWindow.end} of {completions.length}
							</Text>
						)}
					</Box>
				)}
				{isFileAutocompleteMode && fileCompletions.length > 0 && (
					<Box flexDirection="column" marginTop={1}>
						<Text color={colors.secondary}>
							File suggestions (↑/↓ to navigate, Tab to select):
						</Text>
						{fileCompletions.slice(0, 5).map((file, index) => (
							<Text
								key={index}
								color={
									index === selectedFileIndex ? colors.info : colors.primary
								}
								bold={index === selectedFileIndex}
							>
								{index === selectedFileIndex ? '▸ ' : '  '}
								{file.path}
							</Text>
						))}
					</Box>
				)}
				{!colors.promptChar && queuedBlock}
				{isBusy && (
					<Box marginTop={1}>
						<Text color={colors.secondary}>
							<Spinner type="dots" /> Press Esc to cancel
							{onToggleCompactDisplay && (
								<Text>
									{' '}
									· ctrl-o {compactToolDisplay ? 'expand' : 'compact'}{' '}
									{isNarrow ? '' : 'tool results'}
								</Text>
							)}
						</Text>
					</Box>
				)}
			</Box>
			{modelInputBadge && (
				<Box
					justifyContent="flex-end"
					marginTop={-1}
					marginX={1}
					paddingRight={2}
					width={arrowBoxWidth - 2}
				>
					<Text color={colors.info} bold>
						{' '}
						{modelInputBadge}{' '}
					</Text>
				</Box>
			)}

			{attachments.length > 0 && (
				<Box marginTop={1}>
					<Text color={colors.info}>
						{attachments
							.map((img, i) => `[image #${i + 1}: ${img.source ?? 'image'}]`)
							.join(' ')}
					</Text>
					<Text color={colors.secondary}> · ctrl-x remove last</Text>
				</Box>
			)}
			{/* Development mode indicator - always visible */}
			{statusLineSlot ?? (
				<DevelopmentModeIndicator
					developmentMode={developmentMode}
					colors={colors}
					contextPercentUsed={contextPercentUsed ?? null}
					contextSource={contextSource ?? null}
					sessionName={sessionName}
					tune={tune}
					currentModel={currentModel}
					statusInfo={statusInfo}
					activeEditor={activeEditor}
				/>
			)}
		</>
	);
}
