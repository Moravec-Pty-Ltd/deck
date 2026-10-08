import { describe, expect, it } from 'vitest';
import { credentialsFor, keyStillUsed, listCredentials, orphanedKeys } from './credentials-core';
import { credentialKey } from '$lib/types';
import type { ClickupSource, LinearSource, Project } from '$lib/types';

function linear(over: Partial<LinearSource> = {}): LinearSource {
	return {
		id: 'src-lin',
		type: 'linear',
		teamId: 'team-1',
		teamName: 'Engineering',
		assigneeEmail: 'someone@example.com',
		stateIds: ['state-1'],
		...over
	};
}

function clickup(over: Partial<ClickupSource> = {}): ClickupSource {
	return {
		id: 'src-cu',
		type: 'clickup',
		teamId: 'team-9',
		teamName: 'Acme',
		spaceId: 'space-1',
		spaceName: 'Delivery',
		listId: 'list-1',
		listName: 'Backlog',
		statuses: ['to do'],
		assigneeUserId: 4242,
		...over
	};
}

function project(name: string, sources: Project['sources']): Project {
	return { name, path: `/path/to/${name}`, sources };
}

describe('credentialKey', () => {
	it('is the credential when there is one, and the source id otherwise', () => {
		expect(credentialKey(linear({ credentialId: 'cred-a' }))).toBe('cred-a');
		// A source stored before credentials existed keeps its key under its own
		// id, which is what let this ship without a migration.
		expect(credentialKey(linear({ id: 'legacy-1' }))).toBe('legacy-1');
	});

	it('is null for a source that needs no key', () => {
		expect(credentialKey({ id: 'gh', type: 'github', owner: 'acme', repo: 'web' })).toBeNull();
	});
});

describe('listCredentials', () => {
	it('names a Linear key by the account it authenticates as', () => {
		const projects = [project('web', [linear({ credentialId: 'cred-a' })])];
		expect(listCredentials(projects)).toEqual([
			{ id: 'cred-a', type: 'linear', label: 'someone@example.com', projects: ['web'] }
		]);
	});

	it('names a ClickUp key by its username, falling back to the team', () => {
		const named = [project('web', [clickup({ credentialId: 'cred-b', assigneeName: 'someone' })])];
		expect(listCredentials(named)[0].label).toBe('someone');
		// Saved before the username was stored.
		const unnamed = [project('web', [clickup({ credentialId: 'cred-b' })])];
		expect(listCredentials(unnamed)[0].label).toBe('Acme');
	});

	// The whole point: the same key across four projects is one thing to pick,
	// not four identical rows.
	it('groups one key used by several projects into a single entry', () => {
		const projects = [
			project('web', [linear({ id: 's1', credentialId: 'cred-a' })]),
			project('api', [linear({ id: 's2', credentialId: 'cred-a' })]),
			project('docs', [linear({ id: 's3', credentialId: 'cred-a' })])
		];
		const credentials = listCredentials(projects);
		expect(credentials).toHaveLength(1);
		expect(credentials[0].projects).toEqual(['web', 'api', 'docs']);
	});

	it('keeps two different keys apart', () => {
		const projects = [
			project('web', [linear({ id: 's1', credentialId: 'cred-a' })]),
			project('api', [linear({ id: 's2', credentialId: 'cred-b', assigneeEmail: 'other@example.com' })])
		];
		expect(listCredentials(projects).map((c) => c.label)).toEqual([
			'someone@example.com',
			'other@example.com'
		]);
	});

	it('lists a project once however many sources it has on the key', () => {
		const projects = [
			project('web', [
				linear({ id: 's1', credentialId: 'cred-a' }),
				linear({ id: 's2', credentialId: 'cred-a', teamName: 'Design' })
			])
		];
		expect(listCredentials(projects)[0].projects).toEqual(['web']);
	});

	it('ignores GitHub, which stores no key', () => {
		const projects = [project('web', [{ id: 'gh', type: 'github', owner: 'acme', repo: 'web' }])];
		expect(listCredentials(projects)).toEqual([]);
	});

	it('offers only the provider being added', () => {
		const projects = [
			project('web', [linear({ id: 's1', credentialId: 'cred-a' }), clickup({ id: 's2', credentialId: 'cred-b' })])
		];
		expect(credentialsFor(projects, 'linear').map((c) => c.id)).toEqual(['cred-a']);
		expect(credentialsFor(projects, 'clickup').map((c) => c.id)).toEqual(['cred-b']);
		expect(credentialsFor(projects, 'github')).toEqual([]);
	});

	it('copes with a project that has no sources at all', () => {
		expect(listCredentials([project('web', undefined), project('api', [])])).toEqual([]);
	});
});

describe('keyStillUsed', () => {
	const projects = [
		project('web', [linear({ id: 's1', credentialId: 'cred-a' })]),
		project('api', [linear({ id: 's2', credentialId: 'cred-a' })])
	];

	// Before #237 a source owned its key outright, so removing one could simply
	// remove the key. This is the check that stops that taking another project's
	// access with it.
	it('is true while another project still points at the key', () => {
		expect(keyStillUsed(projects, 'cred-a', { projectPath: '/path/to/web', sourceIds: ['s1'] })).toBe(true);
	});

	it('is false once the last source using it is going', () => {
		const alone = [project('web', [linear({ id: 's1', credentialId: 'cred-a' })])];
		expect(keyStillUsed(alone, 'cred-a', { projectPath: '/path/to/web', sourceIds: ['s1'] })).toBe(false);
	});

	// Two projects can hold a source with the same id only by accident, but the
	// exclusion is still scoped to one project so it cannot over-match.
	it('excludes by project as well as by source id', () => {
		const sameIds = [
			project('web', [linear({ id: 'dup', credentialId: 'cred-a' })]),
			project('api', [linear({ id: 'dup', credentialId: 'cred-a' })])
		];
		expect(keyStillUsed(sameIds, 'cred-a', { projectPath: '/path/to/web', sourceIds: ['dup'] })).toBe(true);
	});
});

describe('orphanedKeys', () => {
	it('forgets the key a departing source alone held', () => {
		const projects = [project('web', [linear({ id: 's1', credentialId: 'cred-a' })])];
		expect(orphanedKeys(projects, { projectPath: '/path/to/web', sources: [{ id: 's1' }] })).toEqual(['cred-a']);
	});

	it('keeps a key another project is still pointed at', () => {
		const projects = [
			project('web', [linear({ id: 's1', credentialId: 'cred-a' })]),
			project('api', [linear({ id: 's2', credentialId: 'cred-a' })])
		];
		expect(orphanedKeys(projects, { projectPath: '/path/to/web', sources: [{ id: 's1' }] })).toEqual([]);
	});

	// Removing a project takes all its sources at once, so a key two of its own
	// sources shared is still orphaned by their joint departure.
	it('forgets a key shared only within the project that is leaving', () => {
		const projects = [
			project('web', [
				linear({ id: 's1', credentialId: 'cred-a' }),
				linear({ id: 's2', credentialId: 'cred-a' }),
				clickup({ id: 's3', credentialId: 'cred-b' })
			])
		];
		const orphaned = orphanedKeys(projects, {
			projectPath: '/path/to/web',
			sources: [{ id: 's1' }, { id: 's2' }, { id: 's3' }]
		});
		expect(orphaned.sort()).toEqual(['cred-a', 'cred-b']);
	});

	it('reports a key once however many departing sources held it', () => {
		const projects = [
			project('web', [linear({ id: 's1', credentialId: 'cred-a' }), linear({ id: 's2', credentialId: 'cred-a' })])
		];
		expect(orphanedKeys(projects, { projectPath: '/path/to/web', sources: [{ id: 's1' }, { id: 's2' }] })).toEqual([
			'cred-a'
		]);
	});

	it('says nothing about GitHub sources', () => {
		const projects = [project('web', [{ id: 'gh', type: 'github', owner: 'acme', repo: 'web' }])];
		expect(orphanedKeys(projects, { projectPath: '/path/to/web', sources: [{ id: 'gh' }] })).toEqual([]);
	});
});
