import { describe, expect, it, vi } from 'vitest';
import { thrownError } from './test-env';
import { buildSource, withoutKey, type PickCredential } from './issue-source-core';

const fresh: PickCredential = (b) => ({ credentialId: 'cred-new', apiKey: String(b.apiKey) });
const saved: PickCredential = () => ({ credentialId: 'cred-saved' });

describe('buildSource', () => {
	it('builds a GitHub source without asking for a credential', () => {
		const pick = vi.fn(fresh);
		expect(buildSource('s1', { type: 'github', owner: ' acme ', repo: 'app' }, pick)).toEqual({
			source: { id: 's1', type: 'github', owner: 'acme', repo: 'app' }
		});
		expect(pick).not.toHaveBeenCalled();
	});

	it('returns a supplied key as the secret to stash, never on the source', () => {
		const built = buildSource('s1', { type: 'linear', teamId: 't1', apiKey: 'lin_key_123', stateIds: ['a', ' ', 'b'] }, fresh);
		expect(built.secret).toEqual({ credentialId: 'cred-new', apiKey: 'lin_key_123' });
		expect(built.source).toMatchObject({ type: 'linear', teamId: 't1', stateIds: ['a', 'b'], credentialId: 'cred-new' });
		expect(JSON.stringify(built.source)).not.toContain('lin_key_123');
	});

	it('has nothing to stash when a saved key is reused', () => {
		const built = buildSource('s1', { type: 'linear', teamId: 't1', credentialId: 'cred-saved' }, saved);
		expect(built.secret).toBeUndefined();
		expect(built.source).toMatchObject({ credentialId: 'cred-saved' });
	});

	it('builds a ClickUp source, keeping the folder name only with a folder', () => {
		const body = { type: 'clickup', teamId: 't', spaceId: 'sp', listId: 'l', assigneeUserId: '7', folderName: 'ignored' };
		const { source } = buildSource('s1', body, saved);
		expect(source).toMatchObject({ type: 'clickup', assigneeUserId: 7, folderId: undefined, folderName: undefined });
	});

	it.each([
		[{ type: 'nope' }, 'unknown source type'],
		[{ type: 'github', owner: 'acme' }, 'owner and repo are required'],
		[{ type: 'linear' }, 'teamId is required'],
		[{ type: 'clickup', teamId: 't', spaceId: 'sp', listId: 'l', assigneeUserId: 'x' }, 'teamId, spaceId, listId and assigneeUserId are required']
	])('rejects %j', (body, message) => {
		expect(thrownError(() => buildSource('s1', body, fresh))).toEqual({ status: 400, message });
	});
});

describe('withoutKey', () => {
	it('cuts every copy of the key out of a message', () => {
		expect(withoutKey('Linear API 401: bad key k-1 (k-1)', 'k-1')).toBe('Linear API 401: bad key <redacted> (<redacted>)');
	});

	it('leaves a message alone when there is no key', () => {
		expect(withoutKey('request failed', '')).toBe('request failed');
	});
});
