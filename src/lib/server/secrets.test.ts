import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SecretBackend } from './secrets';

// Point the data dir at a throwaway tmpdir before importing, so config's import
// side effects and the migration's file reads/writes land there.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-secrets-test-'));
process.env.DECK_DATA = dataDir;
const secretsFile = path.join(dataDir, 'secrets.json');

// A fake backend, so the migration is exercised without loading the native
// keyring binding. `failOn` / `corruptOn` stand in for a keyring that rejects a
// write or hands back the wrong value.
function fakeBackend(opts: { failOn?: string; corruptOn?: string } = {}) {
	const stored = new Map<string, string>();
	const backend: SecretBackend = {
		read: (id) => stored.get(id),
		write: (id, apiKey) => {
			if (id === opts.failOn) throw new Error('keyring is locked');
			stored.set(id, id === opts.corruptOn ? 'something else' : apiKey);
		},
		remove: (id) => void stored.delete(id)
	};
	return { backend, stored };
}

const { migrateFileSecrets } = await import('./secrets');

const TWO_KEYS = JSON.stringify({ a: { apiKey: 'key-a' }, b: { apiKey: 'key-b' } });
const TWO_PAIRS = [
	['a', 'key-a'],
	['b', 'key-b']
];

beforeEach(() => {
	fs.rmSync(secretsFile, { force: true });
	vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

describe('migrateFileSecrets', () => {
	it('does nothing when there is no file', () => {
		const { backend, stored } = fakeBackend();
		migrateFileSecrets(backend);
		expect(stored.size).toBe(0);
	});

	it('moves every key across, then deletes the file', () => {
		fs.writeFileSync(secretsFile, TWO_KEYS);
		const { backend, stored } = fakeBackend();
		migrateFileSecrets(backend);
		expect([...stored]).toEqual(TWO_PAIRS);
		expect(fs.existsSync(secretsFile)).toBe(false);
	});

	it('leaves the file in place when a write fails', () => {
		fs.writeFileSync(secretsFile, TWO_KEYS);
		const { backend } = fakeBackend({ failOn: 'b' });
		expect(() => migrateFileSecrets(backend)).toThrow(/source b.*keyring is locked/s);
		expect(fs.readFileSync(secretsFile, 'utf8')).toBe(TWO_KEYS);
	});

	it('leaves the file in place when a key does not read back', () => {
		const contents = JSON.stringify({ a: { apiKey: 'key-a' } });
		fs.writeFileSync(secretsFile, contents);
		const { backend } = fakeBackend({ corruptOn: 'a' });
		expect(() => migrateFileSecrets(backend)).toThrow(/did not read back/);
		expect(fs.readFileSync(secretsFile, 'utf8')).toBe(contents);
	});

	it('refuses to delete a file it could not parse', () => {
		fs.writeFileSync(secretsFile, '{ not json');
		const { backend, stored } = fakeBackend();
		expect(() => migrateFileSecrets(backend)).toThrow(/DECK_SECRETS_FILE/);
		expect(stored.size).toBe(0);
		expect(fs.readFileSync(secretsFile, 'utf8')).toBe('{ not json');
	});

	it('re-imports cleanly after a partial run', () => {
		fs.writeFileSync(secretsFile, TWO_KEYS);
		const { backend, stored } = fakeBackend();
		backend.write('a', 'key-a'); // as if a previous run got this far
		migrateFileSecrets(backend);
		expect([...stored]).toEqual(TWO_PAIRS);
		expect(fs.existsSync(secretsFile)).toBe(false);
	});
});
