import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A home of our own holding one global skill and three plugins: one enabled
// with a skill and a command, one switched off in settings, and one installed
// only for a project's checkout.
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-skills-home-')));
vi.spyOn(os, 'homedir').mockReturnValue(home);
vi.mock('./store', () => ({ listProjects: () => [] }));

const write = (file: string, text: string) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
};
const claude = path.join(home, '.claude');
const plugin = (name: string) => path.join(claude, 'plugins', 'cache', 'market', name, '1.0.0');
write(path.join(claude, 'skills', 'notes', 'SKILL.md'), '---\nname: notes\ndescription: Take notes\n---\n');
write(path.join(plugin('powers'), 'skills', 'brainstorming', 'SKILL.md'), '---\nname: brainstorming\ndescription: Shape an idea\n---\n# Brainstorm');
write(path.join(plugin('powers'), 'commands', 'review.md'), '---\ndescription: Review the diff\n---\nReview it.');
write(path.join(plugin('off'), 'skills', 'hidden', 'SKILL.md'), '---\nname: hidden\ndescription: Switched off\n---\n');
write(path.join(plugin('local'), 'skills', 'scoped', 'SKILL.md'), '---\nname: scoped\ndescription: One checkout only\n---\n');
write(
	path.join(claude, 'plugins', 'installed_plugins.json'),
	JSON.stringify({
		version: 2,
		plugins: {
			'powers@market': [{ scope: 'user', installPath: plugin('powers') }],
			'off@market': [{ scope: 'user', installPath: plugin('off') }],
			'local@market': [{ scope: 'project', projectPath: '/somewhere', installPath: plugin('local') }]
		}
	})
);
write(path.join(claude, 'settings.json'), JSON.stringify({ enabledPlugins: { 'powers@market': true, 'off@market': false } }));

const { skillBody, skillCatalogue } = await import('./skills-catalogue');

afterAll(() => {
	vi.restoreAllMocks();
	fs.rmSync(home, { recursive: true, force: true });
});

describe('skillCatalogue', () => {
	it("adds the enabled user plugins' skills and commands as plugin:name", () => {
		expect(skillCatalogue()).toEqual([
			{ name: 'notes', description: 'Take notes', scope: 'global' },
			{ name: 'powers:brainstorming', description: 'Shape an idea', scope: 'global' },
			{ name: 'powers:review', description: 'Review the diff', scope: 'global' }
		]);
	});

	it('lists only its own skills when no plugins are installed', () => {
		const record = path.join(claude, 'plugins', 'installed_plugins.json');
		const saved = fs.readFileSync(record);
		fs.rmSync(record);
		try {
			expect(skillCatalogue().map((s) => s.name)).toEqual(['notes']);
		} finally {
			fs.writeFileSync(record, saved);
		}
	});
});

describe('skillBody', () => {
	it("reads a plugin skill's or command's text by its plugin:name", () => {
		expect(skillBody('powers:brainstorming')).toContain('# Brainstorm');
		expect(skillBody('powers:review')).toContain('Review it.');
		expect(skillBody('off:hidden')).toBeNull();
		expect(skillBody('powers:missing')).toBeNull();
	});
});
