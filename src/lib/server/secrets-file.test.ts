import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-secrets-home-')));
vi.spyOn(os, 'homedir').mockReturnValue(home);
const { resolveSecretsFile } = await import('./secrets-file');

afterAll(() => {
	vi.restoreAllMocks();
	fs.rmSync(home, { recursive: true, force: true });
});

const secrets = path.join(home, '.secrets');
fs.mkdirSync(secrets);
fs.writeFileSync(path.join(secrets, 'model.env'), 'KEY=x\n');
fs.writeFileSync(path.join(home, 'notes.txt'), 'x');
fs.symlinkSync(path.join(home, 'notes.txt'), path.join(secrets, 'escape'));

describe('resolveSecretsFile', () => {
	it('accepts a file inside ~/.secrets, existing or not', () => {
		expect(resolveSecretsFile('~/.secrets/model.env')).toBe(path.join(secrets, 'model.env'));
		expect(resolveSecretsFile(path.join(secrets, 'later.env'))).toBe(path.join(secrets, 'later.env'));
	});

	it.each([
		'~/notes.txt',
		'~/.secrets',
		'~/.secrets/../notes.txt',
		'~/.secrets/escape',
		'/etc/hosts',
		'.secrets/model.env'
	])('refuses %s', (file) => {
		expect(resolveSecretsFile(file)).toBeNull();
	});
});
