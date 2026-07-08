import { describe, it, expect } from 'vitest';
import { mergeArgs } from './pr';
import type { SessionPR } from '$lib/types';

const pr = (over: Partial<SessionPR> = {}): SessionPR => ({
	url: 'https://github.com/acme/web/pull/7',
	repo: 'acme/web',
	number: 7,
	seenAt: 0,
	...over
});

describe('mergeArgs', () => {
	it('builds a plain merge with the chosen method, repo, and number', () => {
		expect(mergeArgs(pr(), 'squash', false, false)).toEqual([
			'pr',
			'merge',
			'7',
			'-R',
			'acme/web',
			'--squash'
		]);
	});

	it('adds --delete-branch only when requested', () => {
		expect(mergeArgs(pr(), 'merge', true, false)).toContain('--delete-branch');
		expect(mergeArgs(pr(), 'merge', false, false)).not.toContain('--delete-branch');
	});

	// #119: force past branch protection only when the PR is actually blocked; an
	// unblocked merge must never get --admin.
	it('adds --admin only when forcing', () => {
		expect(mergeArgs(pr(), 'rebase', false, true)).toContain('--admin');
		expect(mergeArgs(pr(), 'rebase', false, false)).not.toContain('--admin');
	});
});
