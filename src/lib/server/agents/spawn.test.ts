import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnAgent } from './spawn';

describe('spawnAgent', () => {
	it('rejects with a message naming the binary and PATH, not the argv', async () => {
		const err = await spawnAgent('deck-no-such-agent', ['--secret-prompt'], {}, 10).catch((e) => e);
		expect(err.message).toContain("could not start deck-no-such-agent: it was not found on the server's PATH");
		expect(err.message).not.toContain('--secret-prompt');
	});

	it('blames a missing working directory, not the binary, without retrying', async () => {
		const err = await spawnAgent('sh', [], { cwd: '/deck-no-such-dir' }, 60_000).catch((e) => e);
		expect(err.message).toBe('could not start sh: the working directory /deck-no-such-dir no longer exists');
	});

	it('recovers when the binary appears during the one retry, as after a self-update', async () => {
		const bin = join(mkdtempSync(join(tmpdir(), 'deck-spawn-')), 'agent');
		setTimeout(() => {
			writeFileSync(bin, '#!/bin/sh\nexit 0\n');
			chmodSync(bin, 0o755);
		}, 50);
		const child = await spawnAgent(bin, [], {}, 300);
		const code = await new Promise((r) => child.on('exit', r));
		expect(code).toBe(0);
	});
});
