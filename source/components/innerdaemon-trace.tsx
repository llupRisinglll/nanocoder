import {Box, Text} from 'ink';
import {useTheme} from '@/hooks/useTheme';
import type {SteeringDiagnostic} from '@/steering/types';

/**
 * Format a {@link SteeringDiagnostic} into a single verbose trace line, e.g.
 *   `InnerDaemon · intent=worktree-creation · rule=hilinga-worktree-supervision · budget 2/4 · noop`
 *   `InnerDaemon · intent=runtime-setup · no rule in scope`
 */
export function formatSteeringTrace(d: SteeringDiagnostic): string {
	const parts = [`InnerDaemon · intent=${d.intentClass}`];
	if (d.inScopeRuleId === null) {
		parts.push('no rule in scope');
	} else {
		parts.push(`rule=${d.inScopeRuleId}`);
		if (d.budgetMax > 0) parts.push(`budget ${d.budgetUsed}/${d.budgetMax}`);
	}
	parts.push(d.decision);
	return parts.join(' · ');
}

/**
 * Verbose "proof-of-life" trace for InnerDaemon. One dim `colors.secondary`
 * line surfaced every turn when verbose mode is on — even on a noop — so the
 * steering layer is visibly alive. Deliberately NOT the `◆ InnerDaemon`
 * {@link InnerDaemonDetails} block (that is reserved for real nudges/blocks).
 *
 * Theme-safety: uses only the existing `colors.secondary` field — no new theme
 * fields — so the ~50 bundled themes render this identically.
 */
export default function InnerDaemonTrace({
	diagnostic,
}: {
	diagnostic: SteeringDiagnostic;
}) {
	const {colors} = useTheme();
	return (
		<Box marginTop={1} marginBottom={1}>
			<Text color={colors.secondary} dimColor>
				{formatSteeringTrace(diagnostic)}
			</Text>
		</Box>
	);
}
