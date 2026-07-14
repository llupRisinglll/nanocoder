import {Text} from 'ink';
import React, {useEffect, useState} from 'react';
import {useTheme} from '@/hooks/useTheme';

// Animated gear — same pattern as ink-spinner's Spinner component
const GEAR_FRAMES = ['⚙', '✦'];

export function AnimatedGear() {
	const [frame, setFrame] = useState(0);
	useEffect(() => {
		const timer = setInterval(() => {
			setFrame(prev => (prev === GEAR_FRAMES.length - 1 ? 0 : prev + 1));
		}, 400);
		return () => clearInterval(timer);
	}, []);
	return React.createElement(Text, null, GEAR_FRAMES[frame]);
}

export function formatElapsed(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const mins = Math.floor(seconds / 60);
	const secs = seconds % 60;
	if (mins < 60) return `${mins}m ${secs}s`;
	const hrs = Math.floor(mins / 60);
	const remainMins = mins % 60;
	return `${hrs}hr ${remainMins}m ${secs}s`;
}

/** Live-updating timer — counts up every second while active */
export function ElapsedTimer({startTime}: {startTime: number}) {
	const {colors} = useTheme();
	const [elapsedSeconds, setElapsedSeconds] = useState(0);

	useEffect(() => {
		const timer = setInterval(() => {
			setElapsedSeconds(Math.floor((Date.now() - startTime) / 1000));
		}, 1000);
		return () => clearInterval(timer);
	}, [startTime]);

	if (elapsedSeconds <= 0) {
		return null;
	}

	return (
		<Text
			color={colors.secondary}
		>{` (${formatElapsed(elapsedSeconds)})`}</Text>
	);
}

/** Static elapsed display — shows final frozen time, no live updates */
export function ElapsedDisplay({startTime}: {startTime: number}) {
	const {colors} = useTheme();
	const elapsed = Math.floor((Date.now() - startTime) / 1000);

	if (elapsed <= 0) {
		return null;
	}

	return <Text color={colors.secondary}>{` (${formatElapsed(elapsed)})`}</Text>;
}
