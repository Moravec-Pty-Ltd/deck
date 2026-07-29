import { describe, it, expect } from 'vitest';
import {
	FILE_BACKEND_FLAG,
	fileBackendNotice,
	keyringAccount,
	keyringUnavailableMessage,
	migrationFailureMessage,
	migrationNotice,
	readSecretFrom,
	resolveBackendKind,
	secretEntries,
	withSecret,
	withoutSecret,
	type SecretsFile
} from './secrets-core';

describe('backend selection', () => {
	it('defaults to the keyring', () => {
		expect(resolveBackendKind({})).toBe('keyring');
		expect(resolveBackendKind({ [FILE_BACKEND_FLAG]: '' })).toBe('keyring');
		expect(resolveBackendKind({ [FILE_BACKEND_FLAG]: '0' })).toBe('keyring');
	});

	it('takes the file backend only on an explicit opt-in', () => {
		expect(resolveBackendKind({ [FILE_BACKEND_FLAG]: '1' })).toBe('file');
		expect(resolveBackendKind({ [FILE_BACKEND_FLAG]: 'true' })).toBe('file');
	});
});

describe('keyring accounts', () => {
	it('namespaces the source id', () => {
		expect(keyringAccount('abc123')).toBe('source:abc123');
	});

	it('keeps distinct sources distinct', () => {
		expect(keyringAccount('a')).not.toBe(keyringAccount('b'));
	});
});

describe('secrets file', () => {
	const secrets: SecretsFile = { a: { apiKey: 'key-a' }, b: { apiKey: 'key-b' } };

	it('reads a stored key and misses cleanly', () => {
		expect(readSecretFrom(secrets, 'a')).toBe('key-a');
		expect(readSecretFrom(secrets, 'nope')).toBeUndefined();
		expect(readSecretFrom({}, 'a')).toBeUndefined();
	});

	it('adds and overwrites without mutating the input', () => {
		expect(withSecret(secrets, 'c', 'key-c')).toEqual({ ...secrets, c: { apiKey: 'key-c' } });
		expect(withSecret(secrets, 'a', 'new')).toMatchObject({ a: { apiKey: 'new' } });
		expect(secrets.a.apiKey).toBe('key-a');
	});

	it('removes a key, and reports nothing to do for an absent one', () => {
		expect(withoutSecret(secrets, 'a')).toEqual({ b: { apiKey: 'key-b' } });
		expect(secrets.a).toBeDefined();
		expect(withoutSecret(secrets, 'nope')).toBeNull();
	});

	it('lists entries for migration', () => {
		expect(secretEntries(secrets)).toEqual([
			{ sourceId: 'a', apiKey: 'key-a' },
			{ sourceId: 'b', apiKey: 'key-b' }
		]);
		expect(secretEntries({})).toEqual([]);
	});
});

describe('boot messages', () => {
	it('names both the cause and the opt-in flag when the keyring is unusable', () => {
		const msg = keyringUnavailableMessage('no secret service running');
		expect(msg).toContain('no secret service running');
		expect(msg).toContain(FILE_BACKEND_FLAG);
	});

	it('says the file backend is plaintext, and where', () => {
		const msg = fileBackendNotice('/tmp/deck/secrets.json');
		expect(msg).toContain('/tmp/deck/secrets.json');
		expect(msg).toContain('plaintext');
		expect(msg).toContain('0600');
	});

	it('counts migrated keys, singular and plural', () => {
		expect(migrationNotice(1)).toContain('1 issue-source API key ');
		expect(migrationNotice(3)).toContain('3 issue-source API keys ');
	});

	it('says the file survived a failed migration, and names the flag', () => {
		const msg = migrationFailureMessage('the key for source abc', 'keyring locked');
		expect(msg).toContain('the key for source abc');
		expect(msg).toContain('keyring locked');
		expect(msg).toContain('left in place');
		expect(msg).toContain(FILE_BACKEND_FLAG);
	});
});
