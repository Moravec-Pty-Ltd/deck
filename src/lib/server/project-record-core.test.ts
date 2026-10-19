import { describe, expect, it } from 'vitest';
import type { Project } from '$lib/types';
import { buildProjectRecord } from './project-record-core';

const stored: Project = {
	name: 'Example',
	path: '/path/to/example',
	group: 'apps',
	hidden: true,
	template: 'Work on {issue}',
	reviewPrompt: 'Review it',
	lastBase: 'main',
	lastModels: { claude: { model: 'opus' } },
	lastEffort: 'high',
	sources: [{ id: 's1', type: 'github', owner: 'acme', repo: 'example' }],
	dev: { servers: [] },
	automation: { work: true }
};

describe('buildProjectRecord', () => {
	it('names a new project after its directory', () => {
		expect(buildProjectRecord({}, '/path/to/example')).toEqual({ name: 'example', path: '/path/to/example' });
	});

	it('carries every stored field when the body omits it', () => {
		expect(buildProjectRecord({}, stored.path, stored)).toEqual(stored);
	});

	it('overwrites only the fields sent, and a blank string clears', () => {
		const next = buildProjectRecord({ name: ' Renamed ', group: '', template: 'New' }, stored.path, stored);
		expect(next).toEqual({ ...stored, name: 'Renamed', group: undefined, template: 'New' });
	});

	it('never takes the fields other endpoints own from the body', () => {
		const next = buildProjectRecord({ hidden: false, sources: [], lastModels: {}, lastEffort: 'low' }, stored.path, stored);
		expect(next).toEqual(stored);
	});

	it('falls back to the directory name when a blank name is sent', () => {
		expect(buildProjectRecord({ name: '  ' }, '/path/to/example/').name).toBe('example');
		expect(buildProjectRecord({ name: '' }, stored.path, stored).name).toBe('Example');
	});

	it.each([
		[{ name: 3 }, /name must be a string/],
		[{ group: 3 }, /group must be a string/],
		[{ reviewPrompt: [] }, /reviewPrompt must be a string/],
		[{ dev: 'nope' }, /./],
		[{ automation: 'nope' }, /./]
	])('rejects a malformed field %j', (body, message) => {
		expect(() => buildProjectRecord(body, stored.path, stored)).toThrow(message);
	});

	it('validates a sent dev config', () => {
		const dev = { servers: [{ name: 'web', run: 'pnpm dev' }] };
		expect(buildProjectRecord({ dev }, stored.path, stored).dev).toMatchObject({ servers: [{ name: 'web' }] });
	});
});
