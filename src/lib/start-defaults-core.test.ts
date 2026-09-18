import { describe, expect, it } from 'vitest';
import type { Project } from './types';
import { kindStartDefaults, projectStartDefaults } from './start-defaults-core';

const project: Project = {
	name: 'web',
	path: '/path/to/project',
	template: ' Work on [issue_id] ',
	reviewPrompt: '',
	lastBase: 'main',
	lastModels: { claude: { model: 'sonnet' }, pi: { model: 'gpt', provider: 'openai' } },
	lastEffort: 'high'
};

describe('start defaults', () => {
	it('prefers the project pick, then the global pick, then the built-in default', () => {
		expect(kindStartDefaults('claude', project, {})).toEqual({ model: 'sonnet', effort: 'high', permissionMode: 'bypassPermissions' });
		expect(kindStartDefaults('claude', undefined, { lastModels: { claude: { model: 'haiku' } }, lastEffort: 'low' })).toEqual({ model: 'haiku', effort: 'low', permissionMode: 'bypassPermissions' });
		expect(kindStartDefaults('claude', undefined, {})).toEqual({ model: 'opus', permissionMode: 'bypassPermissions' });
	});
	it('keeps provider for pi only and no effort or permission mode for other kinds', () => {
		expect(kindStartDefaults('pi', project, {})).toEqual({ model: 'gpt', provider: 'openai' });
		expect(kindStartDefaults('codex', project, {})).toEqual({ model: '' });
	});
	it('publishes per-project prompts and base alongside every kind', () => {
		const defaults = projectStartDefaults(project, {});
		expect(defaults.path).toBe('/path/to/project');
		expect(defaults.base).toBe('main');
		expect(defaults.prompts).toEqual({ work: 'Work on [issue_id]' });
		expect(Object.keys(defaults.kinds).sort()).toEqual(['claude', 'codex', 'opencode', 'pi']);
	});
	it('omits unset base and prompts rather than sending blanks', () => {
		const defaults = projectStartDefaults({ name: 'x', path: '/p' }, {});
		expect(defaults).toEqual({ path: '/p', prompts: {}, kinds: expect.any(Object) });
	});
});
