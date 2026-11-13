import { describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	claudeScript,
	killScript,
	parseProjectRemote,
	parseTarget,
	remoteJoin,
	parseFingerprints,
	parseSecret,
	shellQuote,
	sshFailure,
	sshOptions
} from './remote-core';

describe('parseTarget', () => {
	it('reads user, host and port', () => {
		expect(parseTarget('dev@box.example:2222')).toEqual({ user: 'dev', host: 'box.example', port: 2222 });
		expect(parseTarget('box')).toEqual({ user: undefined, host: 'box', port: undefined });
		expect(parseTarget('dev@[::1]:22')).toEqual({ user: 'dev', host: '::1', port: 22 });
	});

	it('refuses option-like or malformed targets', () => {
		for (const t of ['-oProxyCommand=x', 'dev@-host', 'dev@host:0', 'dev@host:70000', 'a b', 'dev@host;rm', '']) {
			expect(parseTarget(t), t).toBeNull();
		}
	});
});

describe('parseProjectRemote', () => {
	const ok = { target: 'dev@box', path: '/srv/app/', auth: { kind: 'key', identityFile: '~/.ssh/id_ed25519' } };

	it('keeps on undefined, clears on null, normalises an object', () => {
		const existing = parseProjectRemote(ok, undefined);
		expect(existing).toEqual({ target: 'dev@box', path: '/srv/app', auth: { kind: 'key', identityFile: '~/.ssh/id_ed25519' } });
		expect(parseProjectRemote(undefined, existing)).toBe(existing);
		expect(parseProjectRemote(null, existing)).toBeUndefined();
		expect(parseProjectRemote({ target: 'box', path: '/a' }, undefined)?.auth).toEqual({ kind: 'default' });
	});

	it('rejects bad fields', () => {
		expect(() => parseProjectRemote({ ...ok, target: '-x' }, undefined)).toThrow(/target/);
		expect(() => parseProjectRemote({ ...ok, path: 'relative' }, undefined)).toThrow(/path/);
		expect(() => parseProjectRemote({ ...ok, auth: { kind: 'key' } }, undefined)).toThrow(/identityFile/);
		expect(() => parseProjectRemote({ ...ok, auth: { kind: 'magic' } }, undefined)).toThrow(/kind/);
		expect(() => parseProjectRemote({ target: 'box', path: '/a', auth: { kind: 'password' } }, undefined)).toThrow(/user/);
		expect(() => parseProjectRemote([], undefined)).toThrow();
	});
});

describe('sshOptions', () => {
	const base = { controlDir: '/d/ssh', knownHosts: '/d/known_hosts' };

	it('uses the deck host ssh config as is for default auth, in batch mode', () => {
		const opts = sshOptions({ ...base, auth: { kind: 'default' }, hasSecret: false });
		expect(opts).toContain('BatchMode=yes');
		expect(opts.join(' ')).not.toContain('UserKnownHostsFile');
		expect(opts).toContain('ControlPath="/d/ssh/%C"');
	});

	it('pins a key and drops batch mode when a passphrase is saved', () => {
		const opts = sshOptions({ ...base, auth: { kind: 'key', identityFile: '~/.ssh/k' }, identityFile: '/h/.ssh/k', hasSecret: true, port: 2222 });
		expect(opts).toEqual(expect.arrayContaining(['-i', '/h/.ssh/k', 'IdentitiesOnly=yes', 'NumberOfPasswordPrompts=1', '-p', '2222']));
		expect(opts).toContain('UserKnownHostsFile="/d/known_hosts"');
		expect(opts).toContain('StrictHostKeyChecking=yes');
		expect(opts).not.toContain('BatchMode=yes');
	});

	it('keeps batch mode for a key without a passphrase', () => {
		expect(sshOptions({ ...base, auth: { kind: 'key', identityFile: '/k' }, hasSecret: false })).toContain('BatchMode=yes');
	});
});

describe('sshFailure', () => {
	it('names each failure', () => {
		expect(sshFailure('@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@', 255, 'box')).toMatch(/changed/);
		expect(sshFailure('No ED25519 host key is known for box and you have requested strict checking.\nHost key verification failed.', 255, 'box')).toMatch(/not been accepted/);
		expect(sshFailure('dev@box: Permission denied (publickey,password).', 255, 'box')).toMatch(/refused the login/);
		expect(sshFailure('ssh: Could not resolve hostname box: nodename nor servname provided', 255, 'box')).toMatch(/Could not reach box/);
		expect(sshFailure('deck: claude not found', 127, 'box')).toMatch(/not on the PATH/);
		expect(sshFailure('deck: remote path not found: /srv/app', 1, 'box')).toBe('remote path not found: /srv/app on box.');
		expect(sshFailure('Connection to box closed by remote host.', 255, 'box')).toMatch(/dropped/);
		expect(sshFailure('some claude error', 1, 'box')).toBeUndefined();
		// The remote command's own error, not ssh's.
		expect(sshFailure('fatal: could not create leading directories: Permission denied', 128, 'box')).toBeUndefined();
	});
});

describe('remoteJoin', () => {
	it('joins inside the root and refuses escapes', () => {
		expect(remoteJoin('/srv/app', '')).toBe('/srv/app');
		expect(remoteJoin('/srv/app/', 'src/./a.ts')).toBe('/srv/app/src/a.ts');
		expect(remoteJoin('/srv/app', '../etc')).toBeNull();
		expect(remoteJoin('/srv/app', '/etc')).toBeNull();
		expect(remoteJoin('/srv/app', 'a\nb')).toBeNull();
	});
});

// The scripts run under a real sh, with a fake `claude` on PATH and a temp HOME.
describe('claudeScript and killScript', () => {
	function fixture() {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-remote-'));
		const bin = path.join(home, 'bin');
		const work = path.join(home, "it's here");
		fs.mkdirSync(bin);
		fs.mkdirSync(work);
		fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\npwd\necho "args:$*"\nwhile :; do sleep 1; done\n', { mode: 0o755 });
		const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home };
		return { home, work, env };
	}

	it('starts claude in the path with quoted args, and records its pid', async () => {
		const { home, work, env } = fixture();
		const script = claudeScript({ id: 'c_ab12', path: work, args: ['-p', "it's"] });
		const child = spawn('sh', ['-c', script], { env });
		const out = await new Promise<string>((resolve) => {
			let buf = '';
			child.stdout.on('data', (d) => {
				buf += d;
				if (buf.includes('args:')) resolve(buf);
			});
		});
		expect(out).toContain(work);
		expect(out).toContain("args:-p it's");
		const pid = fs.readFileSync(path.join(home, '.deck-remote', 'c_ab12.pid'), 'utf8').trim();
		expect(Number(pid)).toBe(child.pid);

		const exited = new Promise((resolve) => child.on('exit', resolve));
		execFileSync('sh', ['-c', killScript('c_ab12', 1)], { env });
		await exited;
		expect(fs.existsSync(path.join(home, '.deck-remote', 'c_ab12.pid'))).toBe(false);
	});

	it('reports a missing path and a missing claude', () => {
		const { work, env } = fixture();
		const run = (script: string, e: Record<string, string>) => {
			try {
				execFileSync('sh', ['-c', script], { env: e, stdio: 'pipe' });
				return '';
			} catch (err) {
				return String((err as { stderr: Buffer }).stderr);
			}
		};
		expect(run(claudeScript({ id: 'c_1', path: '/no/such/dir', args: [] }), env)).toContain('deck: remote path not found');
		expect(run(claudeScript({ id: 'c_1', path: work, args: [] }), { ...env, PATH: '/usr/bin:/bin' })).toContain('deck: claude not found');
	});

	it('leaves a pid that is no longer claude alone', () => {
		const { home, env } = fixture();
		fs.mkdirSync(path.join(home, '.deck-remote'));
		const other = spawn('sleep', ['30']);
		fs.writeFileSync(path.join(home, '.deck-remote', 'c_2.pid'), String(other.pid));
		execFileSync('sh', ['-c', killScript('c_2', 0)], { env });
		expect(other.exitCode).toBeNull();
		other.kill();
	});

	it('keeps the pid file of a claude started during the grace period', async () => {
		const { home, work, env } = fixture();
		const start = () => spawn('sh', ['-c', claudeScript({ id: 'c_3', path: work, args: [] })], { env });
		const pidFile = path.join(home, '.deck-remote', 'c_3.pid');
		const ready = (c: ReturnType<typeof start>) => new Promise((r) => c.stdout.once('data', r));
		const first = start();
		await ready(first);
		const kill = spawn('sh', ['-c', killScript('c_3', 1)], { env });
		await new Promise((r) => first.on('exit', r));
		// The next message's claude starts while the stop still sleeps.
		const second = start();
		await ready(second);
		await new Promise((r) => kill.on('exit', r));
		expect(fs.readFileSync(pidFile, 'utf8').trim()).toBe(String(second.pid));
		execFileSync('sh', ['-c', killScript('c_3', 0)], { env });
		await new Promise((r) => second.on('exit', r));
		expect(fs.existsSync(pidFile)).toBe(false);
	});

	it('ends a stale claude that ignores TERM before starting the next', async () => {
		const { home, work, env } = fixture();
		fs.mkdirSync(path.join(home, '.deck-remote'));
		const stale = spawn('sh', ['-c', "trap '' TERM; while :; do sleep 1; done", 'claude-stale'], { env });
		fs.writeFileSync(path.join(home, '.deck-remote', 'c_4.pid'), String(stale.pid));
		const gone = new Promise((r) => stale.on('exit', r));
		const next = spawn('sh', ['-c', claudeScript({ id: 'c_4', path: work, args: [] })], { env });
		await new Promise((r) => next.stdout.once('data', r));
		expect(stale.exitCode !== null || stale.signalCode !== null).toBe(true);
		await gone;
		next.kill('SIGKILL');
	}, 10_000);

	it('refuses an unsafe session id', () => {
		expect(() => killScript('x; rm -rf ~')).toThrow(/unsafe/);
	});
});

describe('shellQuote', () => {
	it('round-trips through sh', () => {
		const s = `a 'b' "c" $d \`e\``;
		expect(execFileSync('sh', ['-c', `printf %s ${shellQuote(s)}`]).toString()).toBe(s);
	});
});

describe('parseSecret and parseFingerprints', () => {
	it('takes one line of text and the string fingerprints', () => {
		expect(parseSecret('pass word')).toBe('pass word');
		for (const bad of ['', 'a\nb', 42, undefined, 'x'.repeat(4097)]) expect(parseSecret(bad)).toBeNull();
		expect(parseFingerprints(['SHA256:a', 1, null])).toEqual(['SHA256:a']);
		expect(parseFingerprints('SHA256:a')).toEqual([]);
	});
});
