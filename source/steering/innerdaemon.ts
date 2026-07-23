/**
 * InnerDaemon — the steering layer's secondary thinker.
 *
 * A {@link SteeringCandidate} from the detector is handed here when a rule is
 * `mode: 'innerdaemon'`. This module builds the {@link InnerDaemonRequest}, invokes
 * the built-in `innerdaemon` read-only subagent via {@link SubagentExecutor}
 * (NOT via the main agent's `agent` tool — steering is programmatic), and
 * parses its strict-schema text response into an {@link InnerDaemonResponse}.
 *
 * Fail-safe: on ANY parse failure, timeout, or subagent error, returns `noop`.
 * Steering must never act on a malformed or missing InnerDaemon reply.
 *
 * See `docs/auto-steering-architecture.md` §3.
 */

import {INNERDAEMON_RECENT_TURNS} from '@/constants';
import {serializeToolArgs} from '@/steering/intent-classifier';
import type {
	InnerDaemonRequest,
	InnerDaemonResponse,
	SteeringAction,
	TurnFact,
} from '@/steering/types';
import type {SubagentExecutor} from '@/subagents/subagent-executor';
import type {SubagentTask} from '@/subagents/types';
import {getLogger} from '@/utils/logging';

const logger = getLogger();

/**
 * Render a compact, token-bounded view of recent turns for InnerDaemon.
 * InnerDaemon only needs the recent loop (what the model has been doing), not the
 * whole conversation. We summarize each turn to intent + tool calls + errors.
 */
export function renderRecentTurns(facts: TurnFact[]): string {
	const recent = facts.slice(-INNERDAEMON_RECENT_TURNS);
	if (recent.length === 0) return '(no prior turns)';
	return recent
		.map(f => {
			const tools = f.toolCalls
				.map(tc => {
					const name = tc.function?.name ?? '?';
					const args = serializeToolArgs(tc.function?.arguments);
					// Truncate long args (e.g. a heredoc) so one noisy turn
					// doesn't dominate InnerDaemon's context.
					const brief = args.length > 160 ? `${args.slice(0, 160)}…` : args;
					return brief ? `${name}(${brief})` : name;
				})
				.join(', ');
			const err = f.hadError
				? ` [ERROR: ${f.errorMessageDigest ?? 'see results'}]`
				: '';
			const skill = f.userTriggeredSkill
				? ` [skill:${f.userTriggeredSkill}]`
				: '';
			return `  turn ${f.turnIndex}: intent=${f.intentClass}${skill} tools=${tools || '(none)'}${err}`;
		})
		.join('\n');
}

/** Build the InnerDaemon task description (shown in progress UI). */
function buildDescription(ruleId: string, intent: string): string {
	return `InnerDaemon steering check for rule '${ruleId}' (intent: ${intent})`;
}

/** Compose the InnerDaemon user prompt from a request. */
export function buildInnerDaemonPrompt(req: InnerDaemonRequest): string {
	const s = req.situation;
	const lines: string[] = [
		`Rule: ${req.ruleId}`,
		'',
		'## Steering context (the rule body — the main agent has likely ignored this in its skill; re-surface it at the moment of violation):',
		req.ruleBody || '(no rule body provided)',
		'',
		'## Current situation',
		`- Active model: ${s.modelId}`,
		`- Turn intent class: ${s.intentClass}`,
		`- Why the detector flagged this: ${s.triggerReason}`,
	];
	if (s.successCriterion && s.successCriterion !== 'none') {
		lines.push(
			`- Observable success criterion: ${s.successCriterion} — ${s.criterionMet ? 'MET (probably a false alarm — prefer noop)' : 'NOT YET MET'}`,
		);
	}
	if (typeof s.escalationLevel === 'number' && s.escalationLevel > 0) {
		lines.push(
			`- Escalation level: ${s.escalationLevel} — this rule has ALREADY fired ${s.escalationLevel} time(s) without the criterion being met (a RELAPSE). Make your message firmer and more directive than a first nudge; at higher levels the engine will upgrade a repeat inject toward a block.`,
		);
	}
	if (s.implEditedBeforeTest) {
		lines.push(
			'- Ordering signal: implEditedBeforeTest = TRUE — an implementation (non-test) source file was written in THIS task BEFORE any regression test existed. If this rule enforces test-first (TDD) discipline, this confirms the impl-first violation: nudge the model to write the failing regression test first, run it, and watch it fail before editing implementation. If this rule is unrelated to test ordering, ignore this signal.',
		);
	}
	lines.push('', '## Recent turns (oldest → newest):');
	lines.push(renderRecentTurns(s.recentTurns));
	lines.push(
		'',
		'You may use read-only tools (read_file, list_directory, execute_bash for non-mutating checks) to verify observable state before deciding. Then respond with EXACTLY ONE action block per your instructions.',
	);
	return lines.join('\n');
}

/**
 * Parse InnerDaemon's strict text response into an {@link InnerDaemonResponse}.
 * Tolerant of surrounding whitespace; returns null on any malformation.
 */
export function parseInnerDaemonResponse(
	text: string,
): InnerDaemonResponse | null {
	const clean = text.trim();
	// Strip markdown fences if the model wrapped its output.
	const fenced = clean
		.replace(/^```[a-z]*\n?/i, '')
		.replace(/\n?```$/, '')
		.trim();

	const actionMatch = /^ACTION:\s*(\w+)/im.exec(fenced);
	if (!actionMatch) return null;
	const action = actionMatch[1].toLowerCase();

	const field = (name: string): string | undefined => {
		const re = new RegExp(`^${name}:\\s*(.*)$`, 'im');
		const m = re.exec(fenced);
		return m ? m[1].trim() : undefined;
	};

	if (action === 'noop') {
		return {action: 'noop', reason: field('REASON') ?? 'no steering'};
	}
	if (action === 'inject') {
		const message = field('MESSAGE');
		if (!message) return null;
		const urgency = field('URGENCY');
		return {
			action: 'inject',
			message,
			urgency:
				urgency === 'firm' ? 'firm' : urgency === 'light' ? 'light' : 'light',
		};
	}
	if (action === 'block') {
		const message = field('MESSAGE');
		if (!message) return null;
		return {action: 'block', message};
	}
	if (action === 'stop') {
		return {
			action: 'stop',
			reason: field('REASON') ?? 'loop terminated by steering',
		};
	}
	return null;
}

/**
 * Invoke InnerDaemon for a steering request.
 *
 * @param executor The shared SubagentExecutor (owns the parent client + tools).
 * @param req      The request built from a detector candidate.
 * @param signal   Abort signal (cancels with the conversation turn).
 * @returns InnerDaemon's decision, or a `noop` fallback on any failure.
 */
export async function invokeInnerDaemon(
	executor: SubagentExecutor,
	req: InnerDaemonRequest,
	signal?: AbortSignal,
): Promise<InnerDaemonResponse> {
	const task: SubagentTask = {
		subagent_type: 'innerdaemon',
		description: buildDescription(req.ruleId, req.situation.intentClass),
		prompt: buildInnerDaemonPrompt(req),
		context: {ruleId: req.ruleId},
	};

	try {
		const result = await executor.execute(task, signal);
		if (!result.success || !result.output) {
			logger.warn('InnerDaemon invocation failed; falling back to noop', {
				ruleId: req.ruleId,
				error: result.error,
			});
			return {
				action: 'noop',
				reason: `innerdaemon error: ${result.error ?? 'no output'}`,
			};
		}
		const parsed = parseInnerDaemonResponse(result.output);
		if (!parsed) {
			logger.warn(
				'InnerDaemon returned unparseable output; falling back to noop',
				{
					ruleId: req.ruleId,
					outputPreview: result.output.slice(0, 200),
				},
			);
			return {
				action: 'noop',
				reason: 'innerdaemon returned unparseable output',
			};
		}
		return parsed;
	} catch (error) {
		logger.warn('InnerDaemon threw; falling back to noop', {
			ruleId: req.ruleId,
			error: error instanceof Error ? error.message : String(error),
		});
		return {action: 'noop', reason: 'innerdaemon exception'};
	}
}

/** Convert an InnerDaemon decision into a {@link SteeringAction}. */
export function innerdaemonResponseToAction(
	res: InnerDaemonResponse,
): SteeringAction {
	switch (res.action) {
		case 'noop':
			return {type: 'noop', reason: res.reason};
		case 'inject':
			return {type: 'inject', message: res.message, urgency: res.urgency};
		case 'block':
			return {type: 'block', message: res.message};
		case 'stop':
			return {type: 'stop', reason: res.reason};
	}
}
