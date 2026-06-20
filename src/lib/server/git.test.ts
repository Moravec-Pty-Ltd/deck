import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorktree, worktreeAddArgs } from './git';

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
