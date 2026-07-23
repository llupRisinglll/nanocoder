/**
 * Steering rule loader — discovers and parses `.steer.md` files.
 *
 * Mirrors {@link CustomCommandLoader}'s two-source discovery (personal
 * `getConfigPath()/steering/` + project `<root>/.nanocoder/steering/`, project
 * overrides personal), but is simpler: rules have no namespaces, aliases, or
 * resources. Each file is one rule: frontmatter (condition/watch/mode) + body
 * (InnerDaemon domain context).
 *
 * Reuses the shared {@link splitFrontmatter} + {@link parseYamlObject} helpers
 * (same `yaml` library the rest of the codebase uses) rather than pulling in a
 * new frontmatter dependency.
 *
 * See `docs/auto-steering-architecture.md` §4.
 */

import {existsSync, readdirSync, readFileSync, statSync} from 'fs';
import {dirname, join} from 'path';
import {getConfigPath} from '@/config/paths';
import {
	type SteeringCondition,
	type SteeringMode,
	type SteeringRule,
	type SteeringRuleWatch,
	type SteeringToolConstraint,
	type SuccessCriterion,
} from '@/steering/types';
import {parseYamlObject, splitFrontmatter} from '@/utils/frontmatter';
import {logError} from '@/utils/message-queue';

const STEERING_DIR = 'steering';
const RULE_EXTENSION = '.steer.md';

/**
 * Validate that a directory entry doesn't contain path traversal patterns.
 * (Same guard as CustomCommandLoader — defense in depth for fs reads.)
 */
function isSafeEntry(entry: string): boolean {
	return (
		entry !== '..' &&
		entry !== '.' &&
		!entry.includes('/') &&
		!entry.includes('\\')
	);
}

/** AsString coercion for frontmatter values that may arrive as non-strings. */
function asString(v: unknown): string | undefined {
	return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** AsNumber coercion with a default. */
function asNumber(v: unknown, fallback: number): number {
	return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Coerce a frontmatter value into a string array. */
function asStringArray(v: unknown): string[] | undefined {
	if (!Array.isArray(v)) return undefined;
	return v.filter((x): x is string => typeof x === 'string');
}

function parseCondition(raw: unknown): SteeringCondition | undefined {
	if (!raw || typeof raw !== 'object') return undefined;
	const o = raw as Record<string, unknown>;
	const cond: SteeringCondition = {};
	if (o.modelIn) {
		const arr = asStringArray(o.modelIn);
		if (arr) cond.modelIn = arr;
	}
	if (o.modelNotIn) {
		const arr = asStringArray(o.modelNotIn);
		if (arr) cond.modelNotIn = arr;
	}
	if (o.intentClass) cond.intentClass = asString(o.intentClass) as never;
	if (o.userTriggeredSkill)
		cond.userTriggeredSkill = asString(o.userTriggeredSkill);
	if (o.pathMatches) cond.pathMatches = asString(o.pathMatches);
	if (o.cwdIn) {
		const arr = asStringArray(o.cwdIn);
		if (arr) cond.cwdIn = arr;
	}
	if (Array.isArray(o.anyOf)) {
		cond.anyOf = o.anyOf
			.map(sub => parseCondition(sub))
			.filter((c): c is SteeringCondition => c !== undefined);
	}
	return Object.keys(cond).length > 0 ? cond : undefined;
}

function parseConstraint(raw: unknown): SteeringToolConstraint | undefined {
	if (!raw || typeof raw !== 'object') return undefined;
	const o = raw as Record<string, unknown>;
	const tool = asString(o.tool);
	const matches = asStringArray(o.argMatches);
	const message = asString(o.message);
	if (!tool || !matches || !message) return undefined;
	return {tool, argMatches: matches, message};
}

function parseWatch(raw: unknown): SteeringRuleWatch | undefined {
	if (!raw || typeof raw !== 'object') return undefined;
	const o = raw as Record<string, unknown>;
	const watch: SteeringRuleWatch = {};
	const sc = asString(o.successCriterion) as SuccessCriterion | undefined;
	if (sc) watch.successCriterion = sc;
	if (o.maxTurnsWithoutSuccess !== undefined)
		watch.maxTurnsWithoutSuccess = asNumber(o.maxTurnsWithoutSuccess, 0);
	// Time/effort-aware budget (finding #9) — the detector already honors this
	// field; the loader must parse it so a rule can declare it in frontmatter.
	if (o.maxWallClockMsWithoutSuccess !== undefined)
		watch.maxWallClockMsWithoutSuccess = asNumber(
			o.maxWallClockMsWithoutSuccess,
			0,
		);
	// Windowed repeat-detection trigger (runtime-setup-loop). Parsed here so the
	// detector's `countRepeatedLatestCall` gate can be armed from frontmatter.
	if (o.repeatThreshold !== undefined)
		watch.repeatThreshold = asNumber(o.repeatThreshold, 0);
	if (o.repeatToolMatches) {
		const arr = asStringArray(o.repeatToolMatches);
		if (arr) watch.repeatToolMatches = arr;
	}
	if (Array.isArray(o.alsoBlock)) {
		const blocks = o.alsoBlock
			.map(parseConstraint)
			.filter((c): c is SteeringToolConstraint => c !== undefined);
		if (blocks.length > 0) watch.alsoBlock = blocks;
	}
	return Object.keys(watch).length > 0 ? watch : undefined;
}

/**
 * Parse a single `.steer.md` file into a {@link SteeringRule}.
 * Returns undefined on malformed frontmatter (logged, then skipped — one bad
 * rule must not break the whole layer).
 */
export function parseSteeringRule(filePath: string): SteeringRule | undefined {
	let content: string;
	try {
		content = readFileSyncSafe(filePath);
	} catch (error) {
		logError(`steering: cannot read ${filePath}: ${String(error)}`);
		return undefined;
	}
	if (!content) return undefined;

	const {frontmatter, body, hasFrontmatter} = splitFrontmatter(content);
	if (!hasFrontmatter) {
		logError(`steering: ${filePath} has no frontmatter — skipping`);
		return undefined;
	}
	const meta = parseYamlObject(frontmatter);
	if (!meta) {
		logError(`steering: ${filePath} has invalid YAML frontmatter — skipping`);
		return undefined;
	}

	const id = asString(meta.id);
	if (!id) {
		logError(`steering: ${filePath} missing required \`id\` — skipping`);
		return undefined;
	}

	const mode =
		(asString(meta.mode) as SteeringMode | undefined) ?? 'innerdaemon';
	if (
		mode !== 'detector-only' &&
		mode !== 'innerdaemon' &&
		mode !== 'announce'
	) {
		logError(
			`steering: ${filePath} has invalid mode "${String(meta.mode)}" — skipping`,
		);
		return undefined;
	}

	// injectSkill (announce-mode): inline a sibling command skill's body as the
	// announce message, resolved relative to THIS rule's file so a project rule
	// reads project commands and a personal rule reads personal ones. The skill
	// stays the single source of truth — no prose duplication in the rule body.
	const injectSkill = asString(meta.injectSkill);
	let effectiveBody = body || undefined;
	if (injectSkill) {
		if (!/^[a-zA-Z0-9_-]+$/.test(injectSkill)) {
			logError(
				`steering: ${filePath} has invalid injectSkill "${injectSkill}" (name only) — skipping`,
			);
			return undefined;
		}
		const skillPath = join(
			dirname(filePath),
			'..',
			'commands',
			`${injectSkill}.md`,
		); // nosemgrep
		let skillRaw: string;
		try {
			skillRaw = readFileSyncSafe(skillPath);
		} catch {
			logError(
				`steering: ${filePath} injectSkill "${injectSkill}" → cannot read ${skillPath} — skipping`,
			);
			return undefined;
		}
		const skillBody = splitFrontmatter(skillRaw).body.trim();
		if (!skillBody) {
			logError(
				`steering: ${filePath} injectSkill "${injectSkill}" resolved an empty body — skipping`,
			);
			return undefined;
		}
		effectiveBody = skillBody;
	}

	const rule: SteeringRule = {
		id,
		description: asString(meta.description),
		condition: parseCondition(meta.condition),
		watch: parseWatch(meta.watch),
		mode,
		body: effectiveBody,
		source: filePath,
	};
	if (injectSkill) rule.injectSkill = injectSkill;
	if (meta.maxFires !== undefined) rule.maxFires = asNumber(meta.maxFires, 0);
	if (meta.cooldownTurns !== undefined)
		rule.cooldownTurns = asNumber(meta.cooldownTurns, 0);
	return rule;
}

// Thin wrapper so tests can stub fs reads if needed.
function readFileSyncSafe(filePath: string): string {
	return readFileSync(filePath, 'utf8');
}

/**
 * Steering rule loader. Scans personal + project directories, dedupes by rule
 * id (project overrides personal, mirroring command/skill priority).
 */
export class SteeringRuleLoader {
	private rules: Map<string, SteeringRule> = new Map();
	private personalDir: string;
	private projectDir: string;

	constructor(projectRoot: string = process.cwd()) {
		this.personalDir = join(getConfigPath(), STEERING_DIR); // nosemgrep
		this.projectDir = join(projectRoot, '.nanocoder', STEERING_DIR); // nosemgrep
	}

	/** Load (or reload) all steering rules from both sources. */
	loadRules(): SteeringRule[] {
		this.rules.clear();

		// Personal first (lower priority).
		if (existsSync(this.personalDir)) {
			this.scanDirectory(this.personalDir);
		}
		// Project overrides personal (same id → replaced).
		if (existsSync(this.projectDir)) {
			this.scanDirectory(this.projectDir);
		}
		return this.getRules();
	}

	/** Recursively scan a directory for `*.steer.md` files. */
	private scanDirectory(dir: string): void {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!isSafeEntry(entry)) continue;
			const fullPath = join(dir, entry); // nosemgrep
			let st;
			try {
				st = statSync(fullPath);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				this.scanDirectory(fullPath);
			} else if (entry.endsWith(RULE_EXTENSION)) {
				const rule = parseSteeringRule(fullPath);
				if (rule) this.rules.set(rule.id, rule);
			}
		}
	}

	/** All currently-loaded rules (insertion order = personal then project). */
	getRules(): SteeringRule[] {
		return [...this.rules.values()];
	}

	/** Look up a rule by id. */
	getRule(id: string): SteeringRule | undefined {
		return this.rules.get(id);
	}
}
