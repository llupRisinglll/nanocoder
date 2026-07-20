import {findSkill, getLoadedSkills} from '@/skills/skill-registry';
import type {Skill, SkillMemberKind} from '@/types/skills';

function memberKinds(skill: Skill): SkillMemberKind[] {
	const kinds: SkillMemberKind[] = [];
	if (skill.commands?.length) kinds.push('command');
	if (skill.subagent) kinds.push('agent');
	if (skill.tools?.length) kinds.push('tool');
	return kinds;
}

export function formatAvailableSkillsForPrompt(): string | undefined {
	const skills = getLoadedSkills();
	if (skills.length === 0) return undefined;

	const lines = [
		'## AVAILABLE SKILLS',
		'',
		'Skills provide specialized instructions and workflows for specific tasks. If a task matches a skill description, call the `skill` tool with that skill name to load the detailed instructions before proceeding.',
		'',
	];
	for (const skill of [...skills].sort((a, b) =>
		a.name.localeCompare(b.name),
	)) {
		const kinds = memberKinds(skill);
		lines.push(`- ${skill.name}: ${skill.description}`);
		if (skill.tags?.length) lines.push(`  Tags: ${skill.tags.join(', ')}`);
		if (kinds.length) lines.push(`  Provides: ${kinds.join(', ')}`);
	}
	return lines.join('\n');
}

export function formatSkillDetails(name: string): string {
	const skill = findSkill(name);
	if (!skill) {
		const available = getLoadedSkills()
			.map(s => s.name)
			.sort();
		return available.length > 0
			? `Skill "${name}" was not found. Available skills: ${available.join(', ')}`
			: `Skill "${name}" was not found. No skills are loaded.`;
	}

	const lines = [`# Skill: ${skill.name}`, '', skill.description, ''];
	if (skill.tags?.length) lines.push(`Tags: ${skill.tags.join(', ')}`, '');
	if (skill.commands?.length) {
		lines.push('## Commands', '');
		for (const member of skill.commands) {
			lines.push(
				`### ${member.command.fullName}`,
				'',
				member.command.content,
				'',
			);
		}
	}
	if (skill.subagent) {
		lines.push('## Subagent', '', `Name: ${skill.subagent.subagent.name}`, '');
		lines.push(skill.subagent.subagent.systemPrompt, '');
	}
	if (skill.tools?.length) {
		lines.push('## Tools', '');
		for (const member of skill.tools) {
			const desc = member.tool.tool.description ?? 'No description.';
			lines.push(`- ${member.tool.name}: ${desc}`);
		}
		lines.push('');
	}
	lines.push(
		'Use this skill only when it is relevant to the user task. Follow any command/subagent/tool-specific guidance above.',
	);
	return lines.join('\n');
}
