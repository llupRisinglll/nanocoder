/**
 * The steering detector — a pure, deterministic matcher that runs every turn
 * boundary and decides which {@link SteeringRule}s are *candidates* to fire.
 *
 * The detector NEVER calls an LLM and never mutates state. Its only job is to
 * answer "does this rule's condition match the current turn facts, and has the
 * watched budget been exhausted without the success criterion being met?".
 *
 * Candidates are handed to the {@link SteeringEngine}, which applies
 * detector-only actions directly or delegates to InnerDaemon for semantic
 * judgment. Keeping detection pure makes the whole layer unit-testable with
 * synthetic {@link TurnFact}[] histories.
 *
 * See `docs/auto-steering-architecture.md` §2.1, §4.3.
 */

import {DEFAULT_STEERING_BUDGET_TURNS} from '@/constants';
import {matchingArgSubstring} from '@/steering/intent-classifier';
import {
	type IntentClass,
	type SteeringCandidate,
	type SteeringCondition,
	type SteeringRule,
	type SteeringToolConstraint,
	type SuccessCriterion,
	type TurnFact,
} from '@/steering/types';
import type {ToolCall} from '@/types/core';

/**
 * Match a single model id against a glob specifier. Supports trailing `*`
 * wildcards (`'*-mini'` → any id ending in `-mini`) and exact ids. Unlike
 * file-path globs, mid-string `*` is also treated as "any chars" because model
 * ids have no path segments.
 */
export function modelMatchesGlob(modelId: string, glob: string): boolean {
	if (!glob.includes('*')) return modelId === glob;
	// Anchor: `*-mini` → ends with `-mini`; `mimo*` → starts with `mimo`;
	// `*foo*` → contains `foo`. Convert to a RegExp.
	const escaped = glob
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replace(/\*/g, '.*');
	return new RegExp(`^${escaped}$`).test(modelId);
}

/** True if `modelId` matches any glob in the list. */
export function modelMatchesAny(modelId: string, globs: string[]): boolean {
	return globs.some(g => modelMatchesGlob(modelId, g));
}

/**
 * Minimal file-path glob (enough for `pathMatches` conditions like `'ui/**'`).
 * Self-contained so the detector has no dependency on the events system's
 * internal glob helper (which is itself a temporary placeholder for picomatch).
 * Supports `**` (any chars incl `/`), `*` (any chars except `/`), and `?`.
 */
export function pathMatchesGlob(pattern: string, path: string): boolean {
	let out = '^';
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === '*') {
			if (pattern[i + 1] === '*') {
				out += '.*';
				i++;
				if (pattern[i + 1] === '/') i++; // consume trailing / after **
			} else {
				out += '[^/]*';
			}
		} else if (ch === '?') {
			out += '[^/]';
		} else if ('.+()|^${}[]\\'.includes(ch)) {
			out += `\\${ch}`;
		} else {
			out += ch;
		}
	}
	out += '$';
	return new RegExp(out).test(path);
}

/**
 * Evaluate a single {@link SteeringCondition} against one turn's facts.
 * Top-level fields are AND-ed; `anyOf` is OR-ed against the rest.
 */
export function conditionMatches(
	condition: SteeringCondition,
	modelId: string,
	fact: TurnFact,
): boolean {
	if (condition.modelIn && !modelMatchesAny(modelId, condition.modelIn)) {
		return false;
	}
	if (condition.modelNotIn && modelMatchesAny(modelId, condition.modelNotIn)) {
		return false;
	}
	if (condition.intentClass && fact.intentClass !== condition.intentClass) {
		return false;
	}
	if (
		condition.userTriggeredSkill &&
		fact.userTriggeredSkill !== condition.userTriggeredSkill
	) {
		return false;
	}
	if (condition.cwdIn && fact.cwd) {
		if (!modelMatchesAny(fact.cwd, condition.cwdIn)) return false;
	} else if (condition.cwdIn && !fact.cwd) {
		return false;
	}
	if (condition.pathMatches) {
		// pathMatches requires an edited path this turn — checked against any
		// edit-tool path in toolResults/toolCalls. v1: scan edit-tool args.
		const pattern = condition.pathMatches;
		const edited = editedPathsThisTurn(fact);
		if (!edited.some(p => pathMatchesGlob(pattern, p))) {
			return false;
		}
	}
	if (condition.anyOf) {
		if (!condition.anyOf.some(sub => conditionMatches(sub, modelId, fact))) {
			return false;
		}
	}
	return true;
}

/** Paths touched by edit/write tools this turn (for `pathMatches`). */
function editedPathsThisTurn(fact: TurnFact): string[] {
	const EDIT = new Set(['write_file', 'string_replace', 'edit', 'write']);
	const paths: string[] = [];
	for (const tc of fact.toolCalls) {
		if (!EDIT.has(tc.function?.name ?? '')) continue;
		const args = tc.function?.arguments;
		const p =
			(args && (args.path as string)) || (args && (args.file_path as string));
		if (typeof p === 'string') paths.push(p);
	}
	return paths;
}

/**
 * A pluggable checker for {@link SuccessCriterion}. The engine constructs one
 * at evaluation time (it needs cwd/worktree-root context from the loop) and
 * passes it into {@link evaluateRules}. v1 implementations are cheap
 * filesystem/socket checks; Phase 3 wires the events file-watcher.
 */
export interface SuccessCriterionChecker {
	(criterion: SuccessCriterion, fact: TurnFact): boolean;
}

/**
 * Detect candidate rules for the current turn.
 *
 * A rule is a candidate when:
 *  1. Its `condition` matches the latest turn's facts (model + intent/skill/
 *     path), AND
 *  2. Either it has no `watch` (always-active candidate once condition matches),
 *     or its budget is exhausted: the rule has been in-scope for ≥
 *     `watch.maxTurnsWithoutSuccess` consecutive turns without
 *     `watch.successCriterion` being met.
 *
 * `watch.alsoBlock` hard constraints are reported separately via
 * {@link detectConstraintViolations} — they fire instantly, no budget.
 *
 * @param facts   The accumulated turn history (most recent last).
 * @param rules   All loaded steering rules.
 * @param modelId The active model id (for the model gate).
 * @param checker Success-criterion checker (engine-supplied).
 * @returns Candidates the engine should act on / hand to InnerDaemon.
 */
export function evaluateRules(
	facts: TurnFact[],
	rules: SteeringRule[],
	modelId: string,
	checker: SuccessCriterionChecker,
): SteeringCandidate[] {
	if (facts.length === 0) return [];
	const latest = facts[facts.length - 1];
	const candidates: SteeringCandidate[] = [];

	for (const rule of rules) {
		// Condition gate. A rule with no condition is always a candidate
		// (subject to the budget check below).
		if (rule.condition) {
			const matched = conditionMatches(rule.condition, modelId, latest);
			if (!matched) continue;
		}

		// Budget gate: has the rule been in-scope long enough without success?
		const watch = rule.watch;
		if (watch) {
			const budget =
				watch.maxTurnsWithoutSuccess ?? DEFAULT_STEERING_BUDGET_TURNS;
			if (consecutiveInScopeCount(facts, rule, checker) < budget) continue;
		}

		candidates.push({
			rule,
			reason: buildMatchReason(rule, latest, modelId),
			turnIndex: latest.turnIndex,
		});
	}

	return candidates;
}

/**
 * Count consecutive in-scope turns (from the latest backward) that share this
 * rule's intent context and didn't meet the success criterion. A turn where the
 * criterion IS met resets the window. This is the single source of truth for a
 * rule's budget progress — shared by {@link evaluateRules} (the real gate) and
 * {@link describeInScope} (the verbose diagnostic), so the two never diverge.
 */
export function consecutiveInScopeCount(
	facts: TurnFact[],
	rule: SteeringRule,
	checker: SuccessCriterionChecker,
): number {
	const watch = rule.watch;
	let consecutiveInScope = 0;
	for (let i = facts.length - 1; i >= 0; i--) {
		const f = facts[i];
		// Stop the window if the criterion was already met by this turn.
		if (
			watch?.successCriterion &&
			watch.successCriterion !== 'none' &&
			checker(watch.successCriterion, f)
		) {
			break;
		}
		// A turn is "in-scope" for this rule if its condition matched. For budget
		// purposes we approximate in-scope as "same intent class" (cheap) — the
		// condition's full match was already confirmed for `latest`; earlier
		// turns in the same class count.
		if (
			rule.condition?.intentClass &&
			f.intentClass !== rule.condition.intentClass
		) {
			break;
		}
		consecutiveInScope++;
	}
	return consecutiveInScope;
}

/**
 * Diagnostic-only: find the first rule whose condition matches the latest turn
 * (the "in-scope" rule the verbose trace should name) and report its budget
 * progress — even when it is BELOW budget (i.e. no candidate yet). Uses the
 * exact condition + budget primitives {@link evaluateRules} uses, so the two
 * agree on what "in scope" means; this only supplies display fields, never a
 * steering decision.
 *
 * Returns null when no rule's condition matches (the trace then reads
 * "no rule in scope").
 */
export function describeInScope(
	facts: TurnFact[],
	rules: SteeringRule[],
	modelId: string,
	checker: SuccessCriterionChecker,
): {rule: SteeringRule; budgetUsed: number; budgetMax: number} | null {
	if (facts.length === 0) return null;
	const latest = facts[facts.length - 1];
	for (const rule of rules) {
		if (rule.condition && !conditionMatches(rule.condition, modelId, latest)) {
			continue;
		}
		const budgetMax = rule.watch
			? (rule.watch.maxTurnsWithoutSuccess ?? DEFAULT_STEERING_BUDGET_TURNS)
			: 0;
		const budgetUsed = rule.watch
			? consecutiveInScopeCount(facts, rule, checker)
			: 0;
		return {rule, budgetUsed, budgetMax};
	}
	return null;
}

function buildMatchReason(
	rule: SteeringRule,
	fact: TurnFact,
	modelId: string,
): string {
	const parts: string[] = [`model=${modelId}`, `intent=${fact.intentClass}`];
	if (fact.userTriggeredSkill) parts.push(`skill=${fact.userTriggeredSkill}`);
	if (rule.watch?.maxTurnsWithoutSuccess) {
		parts.push(`budget=${rule.watch.maxTurnsWithoutSuccess} turns exceeded`);
	}
	return `${rule.id}: ${parts.join(', ')}`;
}

/**
 * Detect instant (detector-only) hard-constraint violations across all rules'
 * `watch.alsoBlock` lists. These bypass the budget entirely — a forbidden
 * substring in a tool call blocks immediately, no InnerDaemon call.
 *
 * @returns The first violated constraint (with the offending tool call id), or
 * null. Multiple violations in one turn are rare; the first is enough.
 */
export function detectConstraintViolations(
	facts: TurnFact[],
	rules: SteeringRule[],
): {
	rule: SteeringRule;
	constraint: SteeringToolConstraint;
	toolCallId: string;
	matched: string;
} | null {
	if (facts.length === 0) return null;
	const latest = facts[facts.length - 1];
	const constraints: Array<{
		rule: SteeringRule;
		c: SteeringToolConstraint;
	}> = [];
	for (const rule of rules) {
		for (const c of rule.watch?.alsoBlock ?? []) {
			constraints.push({rule, c});
		}
	}
	if (constraints.length === 0) return null;

	for (const tc of latest.toolCalls) {
		for (const {rule, c} of constraints) {
			const matched = matchingArgSubstring(tc, c.tool, c.argMatches);
			if (matched) {
				return {
					rule,
					constraint: c,
					toolCallId: tc.id,
					matched,
				};
			}
		}
	}
	return null;
}

// Re-export for tests/consumers that build facts.
export type {IntentClass, ToolCall};
