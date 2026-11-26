import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { pinEnv } from './test-env';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-remote-'));
const restoreEnv = pinEnv({ DECK_DATA: dir });
const { assertPrivateDir } = await import('./remote');

afterAll(() => {
	restoreEnv();
	fs.rmSync(dir, { recursive: true, force: true });
});

it('takes only a folder of the user that no one else can open', () => {
	const own = path.join(dir, 'own');
	fs.mkdirSync(own, { mode: 0o700 });
	expect(() => assertPrivateDir(own)).not.toThrow();
	expect(() => assertPrivateDir(own, process.getuid!() + 1)).toThrow(/only you/);
	fs.symlinkSync(own, path.join(dir, 'link'));
	expect(() => assertPrivateDir(path.join(dir, 'link'))).toThrow(/only you/);
	fs.chmodSync(own, 0o750);
	expect(() => assertPrivateDir(own)).toThrow(/only you/);
	fs.writeFileSync(path.join(dir, 'file'), '', { mode: 0o600 });
	expect(() => assertPrivateDir(path.join(dir, 'file'))).toThrow(/only you/);
});
