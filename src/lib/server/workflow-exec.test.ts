import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// The review scope rests on these two: a snapshot must capture every kind of
// working-tree change, whoever made it, and two snapshots must diff to ranges.
// Real git in a temp repo; confinement is tested in confine.test.ts.
vi.mock('./confine', () => ({
	resolveWithinProjects: (dir: string) => fs.realpathSync(dir),
	confineRelative: (root: string, rel: string) => path.join(root, rel)
}));

const { deltaBetween, runVerify, snapshotTree, syncPullWorktree, toplevel } = await import('./workflow-exec');

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-exec-'));
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
git('init', '-q');
git('config', 'user.email', 'test@example.com');
git('config', 'user.name', 'test');
fs.writeFileSync(path.join(repo, 'a.ts'), 'one\ntwo\nthree\n');
fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.txt\n');
git('add', '-A');
git('commit', '-qm', 'base');

afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('snapshotTree and deltaBetween', () => {
	it('captures unstaged, staged, and untracked changes without touching the index', async () => {
		const before = await snapshotTree(repo);
		fs.writeFileSync(path.join(repo, 'a.ts'), 'one\nTWO\nthree\n');
		fs.writeFileSync(path.join(repo, 'new.ts'), 'x\ny\n');
		fs.writeFileSync(path.join(repo, 'ignored.txt'), 'nope\n');
		const after = await snapshotTree(repo);
		expect(after).not.toBe(before);
		expect(await deltaBetween(repo, before, after)).toEqual(['a.ts:L2', 'new.ts:L1-2']);
		// The real index is untouched: nothing staged.
		expect(git('diff', '--cached', '--name-only')).toBe('');
	});

	it('is stable when nothing changed', async () => {
		expect(await snapshotTree(repo)).toBe(await snapshotTree(repo));
	});

	it('finds the worktree root from a subdirectory', async () => {
		fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
		expect(await toplevel(path.join(repo, 'sub'))).toBe(fs.realpathSync(repo));
	});
});

describe('syncPullWorktree', () => {
	it('moves a pr/<n> checkout to the PR head and drops what the old round left', async () => {
		const origin = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-origin-'));
		const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-clone-'));
		const at = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
		try {
			at(origin, 'init', '-q', '--bare');
			at(repo, 'remote', 'add', 'origin', origin);
			at(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
			at(repo, 'push', '-q', 'origin', 'HEAD:refs/pull/5/head');
			// The checkout fetched pr/5 when the PR was first reviewed.
			at(clone, 'init', '-q');
			at(clone, 'remote', 'add', 'origin', origin);
			at(clone, 'fetch', '-q', 'origin', 'pull/5/head:pr/5');
			at(clone, 'checkout', '-q', 'pr/5');
			fs.writeFileSync(path.join(clone, 'a.ts'), 'scribbled\n');
			fs.writeFileSync(path.join(clone, 'junk.txt'), 'left behind\n');
			// Then the PR was pushed to again.
			fs.writeFileSync(path.join(repo, 'pushed.ts'), 'new\n');
			at(repo, 'add', '-A');
			at(repo, 'commit', '-qm', 'push two');
			at(repo, 'push', '-q', 'origin', 'HEAD:refs/pull/5/head');
			await syncPullWorktree(clone, 5);
			expect(at(clone, 'rev-parse', 'HEAD')).toBe(at(repo, 'rev-parse', 'HEAD'));
			expect(at(clone, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('pr/5');
			expect(at(clone, 'status', '--porcelain')).toBe('');
			expect(fs.existsSync(path.join(clone, 'pushed.ts'))).toBe(true);
			expect(fs.existsSync(path.join(clone, 'junk.txt'))).toBe(false);
		} finally {
			at(repo, 'remote', 'remove', 'origin');
			fs.rmSync(origin, { recursive: true, force: true });
			fs.rmSync(clone, { recursive: true, force: true });
		}
	});

	it('rejects a PR number that is not a positive integer', async () => {
		await expect(syncPullWorktree(repo, -1)).rejects.toThrow('invalid PR number');
	});
});

describe('runVerify', () => {
	it('returns the exit code and the output tail', async () => {
		expect(await runVerify(repo, 'echo ok')).toEqual({ code: 0, output: 'ok\n' });
		expect((await runVerify(repo, 'echo bad >&2; exit 3')).code).toBe(3);
	});

	it('stops grandchildren too when aborted', async () => {
		const pidFile = path.join(repo, 'child.pid');
		const controller = new AbortController();
		const running = runVerify(repo, `sleep 30 & echo $! > ${pidFile}; wait`, controller.signal);
		for (let i = 0; i < 50 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 20));
		const pid = Number(fs.readFileSync(pidFile, 'utf8'));
		controller.abort();
		expect((await running).code).not.toBe(0);
		await new Promise((r) => setTimeout(r, 50));
		expect(() => process.kill(pid, 0)).toThrow();
	});
});
