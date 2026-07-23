import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import test from 'ava';
import {parseSteeringRule} from './loader';

console.log('\nsteering/loader.spec.ts');

/**
 * Build a temp `.nanocoder/` tree with a steering rule + (optionally) a sibling
 * command skill, and return the rule file path. Mirrors the real on-disk layout
 * so `injectSkill`'s relative resolution (`../commands/<name>.md`) is exercised.
 */
function scaffold(opts: {
	ruleFrontmatter: string;
	ruleBody?: string;
	skillName?: string;
	skillFile?: string; // full file content (frontmatter + body)
}): string {
	const root = mkdtempSync(join(tmpdir(), 'steer-'));
	const nano = join(root, '.nanocoder');
	mkdirSync(join(nano, 'steering'), {recursive: true});
	mkdirSync(join(nano, 'commands'), {recursive: true});
	if (opts.skillName && opts.skillFile) {
		writeFileSync(join(nano, 'commands', `${opts.skillName}.md`), opts.skillFile);
	}
	const rulePath = join(nano, 'steering', 'rule.steer.md');
	writeFileSync(
		rulePath,
		`---\n${opts.ruleFrontmatter}\n---\n${opts.ruleBody ?? ''}`,
	);
	return rulePath;
}

test('injectSkill: inlines the sibling command body (frontmatter stripped)', t => {
	const rulePath = scaffold({
		ruleFrontmatter: [
			'id: x',
			'mode: announce',
			'maxFires: 1',
			'injectSkill: myskill',
			'condition:',
			'  intentClass: frontend-edit',
		].join('\n'),
		ruleBody: '<!-- injected via skill -->',
		skillName: 'myskill',
		skillFile: `---\nname: myskill\ndescription: a skill\n---\n\nDo the skill thing.`,
	});
	const rule = parseSteeringRule(rulePath);
	rmSync(join(rulePath, '..', '..', '..'), {recursive: true, force: true});
	t.truthy(rule);
	t.is(rule?.injectSkill, 'myskill');
	t.is(rule?.body, 'Do the skill thing.', 'body comes from the skill, not the rule file');
});

test('injectSkill: missing command file → rule skipped', t => {
	const rulePath = scaffold({
		ruleFrontmatter: [
			'id: x',
			'mode: announce',
			'injectSkill: nonexistent',
		].join('\n'),
	});
	const rule = parseSteeringRule(rulePath);
	rmSync(join(rulePath, '..', '..', '..'), {recursive: true, force: true});
	t.is(rule, undefined);
});

test('injectSkill: path-traversal name rejected → rule skipped', t => {
	const rulePath = scaffold({
		ruleFrontmatter: [
			'id: x',
			'mode: announce',
			'injectSkill: ../../etc/passwd',
		].join('\n'),
	});
	const rule = parseSteeringRule(rulePath);
	rmSync(join(rulePath, '..', '..', '..'), {recursive: true, force: true});
	t.is(rule, undefined);
});

test('no injectSkill: literal body is preserved', t => {
	const rulePath = scaffold({
		ruleFrontmatter: ['id: x', 'mode: announce'].join('\n'),
		ruleBody: 'Literal announce body.',
	});
	const rule = parseSteeringRule(rulePath);
	rmSync(join(rulePath, '..', '..', '..'), {recursive: true, force: true});
	t.is(rule?.body, 'Literal announce body.');
	t.is(rule?.injectSkill, undefined);
});
