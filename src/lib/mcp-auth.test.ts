import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { mcpAllowed, writeMcpConfig } from './mcp-auth';

it('admits only the right secret, addressed to loopback', () => {
	const ok = { host: '127.0.0.1:5000', authorization: 'Bearer s3cret' };
	expect(mcpAllowed(ok, 5000, 's3cret')).toBe(true);
	expect(mcpAllowed({ ...ok, host: 'localhost:5000' }, 5000, 's3cret')).toBe(true);
	for (const host of [undefined, 'example.com:5000', '127.0.0.1:5001', '127.0.0.1']) {
		expect(mcpAllowed({ ...ok, host }, 5000, 's3cret')).toBe(false);
	}
	for (const authorization of [undefined, '', 'Bearer ', 'Bearer other', 's3cret']) {
		expect(mcpAllowed({ ...ok, authorization }, 5000, 's3cret')).toBe(false);
	}
});

it('writes a private config, also over a looser one', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-auth-'));
	try {
		const file = path.join(dir, 'c.json');
		fs.writeFileSync(file, 'old', { mode: 0o644 });
		writeMcpConfig(file, 'http://127.0.0.1:1/mcp', 's3cret');
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		expect(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.deck).toEqual({
			type: 'http', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer s3cret' }
		});
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
