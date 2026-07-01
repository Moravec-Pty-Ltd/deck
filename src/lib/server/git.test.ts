import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	createWorktree,
	worktreeAddArgs,
	worktreeDiff,
	parseNumstat,
	capPatch,
	fetchPullRef,
	parseOriginRepo
} from './git';

// Lock the argv ordering: every positional arg must sit after `--`, so the test
// fails if the separator is dropped or reordered (the S4 regression guard).
describe('worktreeAddArgs', () => {
	it('puts the dir after `--` for a new branch', () => {
		expect(worktreeAddArgs('/d', 'b', { newBranch: true })).toEqual([
			'worktree',
			'add',
			'-b',
			'b',
			'--',
			'/d'
		]);
	});

	it('appends the base as a positional after the dir', () => {
		expect(worktreeAddArgs('/d', 'b', { newBranch: true, base: 'main' })).toEqual([
			'worktree',
			'add',
			'-b',
			'b',
			'--',
			'/d',
			'main'
		]);
	});

	it('puts dir and branch after `--` for an existing branch', () => {
		expect(worktreeAddArgs('/d', 'b', {})).toEqual(['worktree', 'add', '--', '/d', 'b']);
	});
});

// The guards run before any fs/git work, so these reject without touching the
// (non-existent) repo path.
describe('createWorktree input guards', () => {
	it('rejects a branch name that would be parsed as a git flag', async () => {
		await expect(createWorktree('/repo', '--force', { newBranch: true })).rejects.toThrow(
			/unsafe branch/
		);
		await expect(createWorktree('/repo', '-b', {})).rejects.toThrow(/unsafe branch/);
	});

	it('rejects a base branch that would be parsed as a git flag', async () => {
		await expect(
			createWorktree('/repo', 'feature', { newBranch: true, base: '--detach' })
		).rejects.toThrow(/unsafe base/);
	});

	it('rejects a branch that escapes the worktrees root via path traversal', async () => {
		await expect(createWorktree('/repo', '..', { newBranch: true })).rejects.toThrow(
			/unsafe branch/
		);
		await expect(createWorktree('/repo', '.', {})).rejects.toThrow(/unsafe branch/);
	});
});

// Exercise the real `git worktree add` invocation so the positional-args-after-`--`
// ordering is actually verified end-to-end (a dropped/reordered `--` would fail).
describe('createWorktree against a real repo', () => {
	const env = {
		...process.env,
		GIT_AUTHOR_NAME: 't',
		GIT_AUTHOR_EMAIL: 't@t',
		GIT_COMMITTER_NAME: 't',
		GIT_COMMITTER_EMAIL: 't@t'
	};
	const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-git-repo-')));
	execFileSync('git', ['init', '-q', repo], { env });
	execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-q', '-m', 'init'], { env });
	const branchOf = (dir: string) =>
		execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { env })
			.toString()
			.trim();

	afterAll(() => {
		fs.rmSync(repo, { recursive: true, force: true });
		fs.rmSync(`${repo}-worktrees`, { recursive: true, force: true });
	});

	it('creates a worktree on a new branch', async () => {
		const dir = await createWorktree(repo, 'feature-x', { newBranch: true });
		expect(fs.existsSync(dir)).toBe(true);
		expect(branchOf(dir)).toBe('feature-x');
	});

	it('checks out an existing branch into a worktree', async () => {
		execFileSync('git', ['-C', repo, 'branch', 'existing-b'], { env });
		const dir = await createWorktree(repo, 'existing-b', { newBranch: false });
		expect(fs.existsSync(dir)).toBe(true);
		expect(branchOf(dir)).toBe('existing-b');
	});

	it('is idempotent when the worktree dir already exists', async () => {
		const first = await createWorktree(repo, 'feature-x', { newBranch: true });
		const second = await createWorktree(repo, 'feature-x', { newBranch: true });
		expect(second).toBe(first);
	});
});

// The number guard runs before any git work, so a bad PR number rejects without
// touching the repo (and the derived pr/<n> ref is asserted isFlagSafe too).
describe('fetchPullRef input guards', () => {
	it('rejects a non-positive or non-integer PR number', async () => {
		await expect(fetchPullRef('/repo', 0)).rejects.toThrow(/invalid PR number/);
		await expect(fetchPullRef('/repo', -3)).rejects.toThrow(/invalid PR number/);
		await expect(fetchPullRef('/repo', 1.5)).rejects.toThrow(/invalid PR number/);
		await expect(fetchPullRef('/repo', Number.NaN)).rejects.toThrow(/invalid PR number/);
		await expect(fetchPullRef('/repo', 1e21)).rejects.toThrow(/invalid PR number/);
	});
});

describe('fetchPullRef against a real repo', () => {
	const env = {
		...process.env,
		GIT_AUTHOR_NAME: 't',
		GIT_AUTHOR_EMAIL: 't@t',
		GIT_COMMITTER_NAME: 't',
		GIT_COMMITTER_EMAIL: 't@t'
	};
	const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-pr-repo-')));
	execFileSync('git', ['init', '-q', repo], { env });
	execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-q', '-m', 'init'], { env });

	afterAll(() => {
		fs.rmSync(repo, { recursive: true, force: true });
	});

	it('reuses an existing pr/<n> branch without fetching', async () => {
		execFileSync('git', ['-C', repo, 'branch', 'pr/7'], { env });
		await expect(fetchPullRef(repo, 7)).resolves.toBe('pr/7');
	});

	it('wraps a fetch failure (no GitHub origin) in a clear error', async () => {
		await expect(fetchPullRef(repo, 4242)).rejects.toThrow(/failed to fetch PR #4242/);
	});
});

describe('parseOriginRepo', () => {
	it('parses https, ssh, scp-style, and aliased remotes', () => {
		expect(parseOriginRepo('https://github.com/acme/web.git')).toBe('acme/web');
		expect(parseOriginRepo('https://github.com/acme/web')).toBe('acme/web');
		expect(parseOriginRepo('https://github.com/acme/web/')).toBe('acme/web');
		expect(parseOriginRepo('git@github.com:acme/web.git')).toBe('acme/web');
		expect(parseOriginRepo('ssh://git@github.com/acme/web.git')).toBe('acme/web');
		expect(parseOriginRepo('ssh://git@github.com:22/acme/web.git')).toBe('acme/web');
		expect(parseOriginRepo('https://user:token@github.com/acme/web.git')).toBe('acme/web');
		expect(parseOriginRepo('git@github-work:acme/web.git')).toBe('acme/web');
		expect(parseOriginRepo('https://github.com/acme/web.git/')).toBe('acme/web');
		expect(parseOriginRepo('  https://github.com/acme/web.git\n')).toBe('acme/web');
	});

	it('returns null when the url has no owner/repo tail', () => {
		expect(parseOriginRepo('')).toBeNull();
		expect(parseOriginRepo('not-a-url')).toBeNull();
	});

	it('returns null for a local-path remote (not fetchable via pull/*)', () => {
		expect(parseOriginRepo('../acme/web')).toBeNull();
		expect(parseOriginRepo('/home/me/acme/web')).toBeNull();
		expect(parseOriginRepo('~/code/acme/web')).toBeNull();
	});
});

describe('parseNumstat', () => {
	it('sums additions and deletions and counts files', () => {
		expect(parseNumstat('3\t1\tone.txt\n0\t2\ttwo.txt\n')).toEqual({
			fileCount: 2,
			additions: 3,
			deletions: 3
		});
	});

	it('treats binary rows (-) as zero', () => {
		expect(parseNumstat('-\t-\timg.png\n5\t0\tcode.ts\n')).toEqual({
			fileCount: 2,
			additions: 5,
			deletions: 0
		});
	});

	it('is empty for an empty diff', () => {
		expect(parseNumstat('')).toEqual({ fileCount: 0, additions: 0, deletions: 0 });
	});
});

describe('capPatch', () => {
	it('keeps a patch under the cap untouched', () => {
		const patch = 'diff --git a/f b/f\n+hi\n';
		expect(capPatch(patch)).toEqual({ patch, truncated: false });
	});

	it('drops whole files once the cap is exceeded', () => {
		const big = 'x'.repeat(3 * 1024 * 1024);
		const fileA = `diff --git a/a b/a\n${big}\n`;
		const fileB = `diff --git a/b b/b\n${big}\n`;
		const result = capPatch(fileA + fileB);
		expect(result.truncated).toBe(true);
		expect(result.patch).toBe(fileA);
		expect(result.patch).not.toContain('b/b');
	});
});

// Build a base commit, branch off it, then layer committed + staged + unstaged +
// untracked changes so the diff has one of each kind to surface.
describe('worktreeDiff against a real repo', () => {
	const env = {
		...process.env,
		GIT_AUTHOR_NAME: 't',
		GIT_AUTHOR_EMAIL: 't@t',
		GIT_COMMITTER_NAME: 't',
		GIT_COMMITTER_EMAIL: 't@t'
	};
	const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-diff-repo-')));
	const run = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { env });
	const write = (name: string, body: string) => fs.writeFileSync(path.join(repo, name), body);

	execFileSync('git', ['init', '-q', '-b', 'main', repo], { env });
	write('tracked.txt', 'base\n');
	run('add', '-A');
	run('commit', '-qm', 'base');
	run('checkout', '-qb', 'feature');
	write('committed.txt', 'committed\n');
	run('add', '-A');
	run('commit', '-qm', 'work');
	write('staged.txt', 'staged\n');
	run('add', 'staged.txt');
	write('tracked.txt', 'base\nunstaged\n');
	write('untracked.txt', 'untracked\n');

	afterAll(() => {
		fs.rmSync(repo, { recursive: true, force: true });
	});

	it('captures committed, staged, unstaged and untracked changes since base', async () => {
		const { patch, meta } = await worktreeDiff(repo, 'main');
		expect(meta.baseResolved).toBe(true);
		expect(meta.baseRef).toBe('main');
		expect(patch).toContain('committed.txt');
		expect(patch).toContain('staged.txt');
		expect(patch).toContain('+unstaged');
		expect(patch).toContain('untracked.txt');
		expect(meta.fileCount).toBe(4);
		expect(meta.additions).toBe(4);
	});

	it('leaves the real index untouched (untracked stays untracked)', async () => {
		await worktreeDiff(repo, 'main');
		const status = run('status', '--porcelain').toString();
		expect(status).toContain('?? untracked.txt');
	});

	it('resolves the default branch when no base is given', async () => {
		const { meta } = await worktreeDiff(repo);
		expect(meta.baseResolved).toBe(true);
		expect(meta.baseRef).toBe('main');
	});

	it('falls back to HEAD when the base has no shared history', async () => {
		const { meta } = await worktreeDiff(repo, 'nope-not-a-ref');
		expect(meta.baseResolved).toBe(false);
		expect(meta.baseRef).toBe('HEAD');
	});
});
