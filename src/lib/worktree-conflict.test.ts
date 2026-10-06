import { describe, expect, it } from 'vitest';
import { conflictMessage, isWorktreeFix, worktreeConflict } from './worktree-conflict';

describe('worktreeConflict', () => {
	it("reads git's branch-already-exists failure", () => {
		const stderr = [
			"Command failed: git -C /path/to/project worktree add -b feature-2199 -- /path/to/project-worktrees/feature-2199 main",
			"Preparing worktree (new branch 'feature-2199')",
			"fatal: a branch named 'feature-2199' already exists"
		].join('\n');
		expect(worktreeConflict(stderr)).toBe('branch-exists');
	});

	it('reads the stale-worktree failure, which is the other way round', () => {
		const stderr = "fatal: 'feature-2199' is already checked out at '/path/to/project-worktrees/feature-2199'";
		expect(worktreeConflict(stderr)).toBe('stale-worktree');
	});

	it('leaves an unrelated failure unclassified, so it is reported as-is', () => {
		expect(worktreeConflict('fatal: not a git repository')).toBeNull();
		expect(worktreeConflict('error: pathspec did not match')).toBeNull();
		expect(worktreeConflict('')).toBeNull();
	});

	it('names the branch in what the user is told', () => {
		expect(conflictMessage('branch-exists', 'feature-2199')).toContain('feature-2199');
		expect(conflictMessage('stale-worktree', 'feature-2199')).toContain('feature-2199');
		expect(conflictMessage(null, 'feature-2199')).toBe('');
	});
});

describe('isWorktreeFix', () => {
	it('accepts only the two fixes', () => {
		expect(isWorktreeFix('reuse')).toBe(true);
		expect(isWorktreeFix('recreate')).toBe(true);
		expect(isWorktreeFix('force')).toBe(false);
		expect(isWorktreeFix(undefined)).toBe(false);
	});
});
