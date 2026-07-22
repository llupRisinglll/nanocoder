import test from 'ava';
import React from 'react';
import {renderWithTheme} from '../test-utils/render-with-theme';
import InnerDaemonDetails from './innerdaemon-details';

console.log(`\ninnerdaemon-details.spec.tsx – ${React.version}`);

test('InnerDaemonDetails renders the glyph header + nudge body (light)', t => {
	const {lastFrame} = renderWithTheme(
		<InnerDaemonDetails message="Use the verified scripts. Do not hand-roll the worktree." />,
	);
	const out = lastFrame();
	t.truthy(out);
	t.regex(out!, /◆ InnerDaemon/);
	t.regex(out!, /Use the verified scripts/);
});

test('InnerDaemonDetails shows ruleId when provided', t => {
	const {lastFrame} = renderWithTheme(
		<InnerDaemonDetails message="nudge" ruleId="worktree-supervision" />,
	);
	t.regex(lastFrame()!, /worktree-supervision/);
});

test('InnerDaemonDetails firm urgency shows the steering marker', t => {
	const {lastFrame} = renderWithTheme(
		<InnerDaemonDetails message="Stop hand-rolling." urgency="firm" />,
	);
	const out = lastFrame()!;
	t.regex(out, /◆ InnerDaemon/);
	t.regex(out, /steering/);
	t.regex(out, /Stop hand-rolling/);
});

test('InnerDaemonDetails light urgency omits the steering marker', t => {
	const {lastFrame} = renderWithTheme(
		<InnerDaemonDetails message="gentle nudge" urgency="light" />,
	);
	const out = lastFrame()!;
	t.regex(out, /◆ InnerDaemon/);
	// "steering" marker only appears on firm urgency
	t.notRegex(out, /\(steering\)/);
});

test('InnerDaemonDetails renders multi-sentence markdown without throwing', t => {
	const msg =
		'You appear stuck on runtime setup. Decide now: get the server up, or report BLOCKER and stop. Do not try another launch strategy.';
	const {lastFrame} = renderWithTheme(<InnerDaemonDetails message={msg} />);
	t.regex(lastFrame()!, /runtime setup/);
	t.regex(lastFrame()!, /BLOCKER/);
});
