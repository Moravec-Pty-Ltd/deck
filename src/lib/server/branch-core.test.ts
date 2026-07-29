import { describe, it, expect } from 'vitest';
import { slugifyBranch, worktreeDirName } from './branch-core';

describe('slugifyBranch', () => {
	it('leaves an already-valid ref alone', () => {
		expect(slugifyBranch('ABC-123')).toBe('ABC-123');
		expect(slugifyBranch('fix_the.thing-2')).toBe('fix_the.thing-2');
	});

	it('flattens a github issue id into a readable branch', () => {
		expect(slugifyBranch('owner/repo#198')).toBe('owner-repo-198');
		expect(slugifyBranch('jinbe/deck#200')).toBe('jinbe-deck-200');
	});

	it('collapses whitespace and runs of separators', () => {
		expect(slugifyBranch('fix   the  thing')).toBe('fix-the-thing');
		expect(slugifyBranch('a///b')).toBe('a-b');
		expect(slugifyBranch('a -- b')).toBe('a-b');
	});

	it('replaces the characters git rejects in a ref', () => {
		expect(slugifyBranch('a~b^c:d?e*f[g\\h')).toBe('a-b-c-d-e-f-g-h');
		expect(slugifyBranch('a b\tc')).toBe('a-b-c');
		expect(slugifyBranch('head@{0}')).toBe('head-0');
	});

	it('folds accented latin and drops characters with no ascii form', () => {
		expect(slugifyBranch('café-münchen')).toBe('cafe-munchen');
		expect(slugifyBranch('日本語')).toBe('');
	});

	it('rejects the reserved forms', () => {
		expect(slugifyBranch('.')).toBe('');
		expect(slugifyBranch('..')).toBe('');
		expect(slugifyBranch('@')).toBe('');
		expect(slugifyBranch('/leading/trailing/')).toBe('leading-trailing');
		expect(slugifyBranch('a..b')).toBe('a.b');
		expect(slugifyBranch('feature.lock')).toBe('feature');
		expect(slugifyBranch('feature.LOCK.lock')).toBe('feature');
		expect(slugifyBranch('.lock')).toBe('lock');
	});

	it('caps over-long input without leaving a trailing separator', () => {
		const long = slugifyBranch('x'.repeat(300));
		expect(long).toHaveLength(100);
		expect(slugifyBranch(`${'y'.repeat(99)}-tail`)).toBe('y'.repeat(99));
	});

	it('returns empty for blank input', () => {
		expect(slugifyBranch('')).toBe('');
		expect(slugifyBranch('   ')).toBe('');
	});

	it('produces a name that is its own worktree dir', () => {
		const slug = slugifyBranch('owner/repo#198');
		expect(worktreeDirName(slug)).toBe(slug);
	});
});

describe('worktreeDirName', () => {
	it('flattens a nested existing branch', () => {
		expect(worktreeDirName('feat/thing')).toBe('feat-thing');
	});

	it('leaves a flat branch alone', () => {
		expect(worktreeDirName('pr/42')).toBe('pr-42');
		expect(worktreeDirName('ABC-123')).toBe('ABC-123');
	});
});
