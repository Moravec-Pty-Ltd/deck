import { describe, expect, it, vi, beforeEach } from 'vitest';
import { thrownError } from './test-env';
import type { LinearSource, Project } from '$lib/types';

// The boundary rules the pure grouping cannot check: that a credentialId names
// a key this deck has actually saved, and that reusing one writes nothing.
// Both reach the project store and the keyring, so they run over fakes here.
const fake = vi.hoisted(() => ({
	projects: [] as Project[],
	secrets: {} as Record<string, string>
}));

vi.mock('./store', () => ({
	listProjects: () => fake.projects,
	readSecret: (id: string) => fake.secrets[id]
}));

const { credentialForSource, resolveApiKey } = await import('./credentials');

function linearSource(over: Partial<LinearSource> = {}): LinearSource {
	return {
		id: 'src-1',
		type: 'linear',
		teamId: 'team-1',
		teamName: 'Engineering',
		assigneeEmail: 'someone@example.com',
		stateIds: ['s1'],
		credentialId: 'cred-a',
		...over
	};
}

beforeEach(() => {
	fake.projects = [{ name: 'alpha', path: '/path/to/alpha', sources: [linearSource()] }];
	fake.secrets = { 'cred-a': 'the-stored-key' };
});

describe('resolveApiKey', () => {
	it('uses a key supplied in the request', () => {
		expect(resolveApiKey({ apiKey: '  typed-key  ' })).toBe('typed-key');
	});

	// This is the path that keeps a reused key out of the browser: the request
	// names the credential, the server fetches the key.
	it('reads a saved key the request only names', () => {
		expect(resolveApiKey({ credentialId: 'cred-a' })).toBe('the-stored-key');
	});

	it('prefers a supplied key over a named one', () => {
		expect(resolveApiKey({ apiKey: 'typed-key', credentialId: 'cred-a' })).toBe('typed-key');
	});

	it('refuses a request with neither', () => {
		expect(thrownError(() => resolveApiKey({}))).toEqual({
			status: 400,
			message: 'apiKey or credentialId required'
		});
	});

	// A stale id from an old tab must fail here rather than read whatever else
	// happens to be in the secret store under that name.
	it('refuses an id this deck has not saved, even when the store holds it', () => {
		fake.secrets['someone-elses-entry'] = 'not-ours';
		expect(thrownError(() => resolveApiKey({ credentialId: 'someone-elses-entry' }))).toEqual({
			status: 400,
			message: 'that saved key no longer exists'
		});
	});

	// Saved according to the projects, gone from the keyring: a different fault
	// from a stale id, and re-entering the key is the fix.
	it('says so when a saved key has vanished from the keyring', () => {
		fake.secrets = {};
		expect(thrownError(() => resolveApiKey({ credentialId: 'cred-a' }))).toMatchObject({
			status: 400,
			message: expect.stringMatching(/could not be read/)
		});
	});

	it('finds a key saved under a legacy source with no credentialId', () => {
		fake.projects = [
			{ name: 'alpha', path: '/path/to/alpha', sources: [linearSource({ id: 'legacy-1', credentialId: undefined })] }
		];
		fake.secrets = { 'legacy-1': 'legacy-key' };
		expect(resolveApiKey({ credentialId: 'legacy-1' })).toBe('legacy-key');
	});
});

describe('credentialForSource', () => {
	it('mints a credential for a key being saved', () => {
		const resolved = credentialForSource({ apiKey: 'typed-key' });
		expect(resolved.apiKey).toBe('typed-key');
		expect(resolved.credentialId).toMatch(/^[0-9a-f-]{36}$/);
	});

	// Reuse has nothing to store: the absent apiKey is what tells the route not
	// to write, so a second project cannot overwrite the shared key with a blank.
	it('reuses a saved credential and leaves nothing to write', () => {
		expect(credentialForSource({ credentialId: 'cred-a' })).toEqual({ credentialId: 'cred-a' });
	});

	it('refuses a request with neither', () => {
		expect(thrownError(() => credentialForSource({}))).toMatchObject({ status: 400 });
	});

	it('refuses an id this deck has not saved', () => {
		expect(thrownError(() => credentialForSource({ credentialId: 'nope' }))).toEqual({
			status: 400,
			message: 'that saved key no longer exists'
		});
	});

	// A saved id wins, so a form that still has a stale value in its password
	// field cannot quietly replace the key every other project is using.
	it('prefers a named credential over a key also supplied', () => {
		expect(credentialForSource({ credentialId: 'cred-a', apiKey: 'typed-key' })).toEqual({
			credentialId: 'cred-a'
		});
	});
});
