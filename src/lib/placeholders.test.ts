import { describe, it, expect } from 'vitest';
import { expandPlaceholders, contextFromSession } from './placeholders';
import type { DeckSession } from '$lib/types';

describe('expandPlaceholders', () => {
	const ctx = {
		title: 'Fix login',
		branch: 'jin/fix-login',
		base: 'main',
		cwd: '/path/to/project',
		issueId: 'acme#12',
		issueUrl: 'https://example.com/issues/12',
		prUrl: 'https://example.com/pull/34',
		prNumber: '34',
		prTitle: 'Add widget',
		prBranch: 'pr/34',
		prBase: 'main'
	};

	it('substitutes every token', () => {
		const text = '[title] [branch-name] [base-branch] [branch] [cwd] [issue_id] [issue_url] [pr_url]';
		expect(expandPlaceholders(text, ctx)).toBe(
			'Fix login jin/fix-login main jin/fix-login /path/to/project acme#12 https://example.com/issues/12 https://example.com/pull/34'
		);
	});

	it('substitutes the PR tokens', () => {
		const text = '[pr_number] [pr_title] [pr_branch] [pr_base]';
		expect(expandPlaceholders(text, ctx)).toBe('34 Add widget pr/34 main');
	});

	it('treats [branch] as an alias for [branch-name]', () => {
		expect(expandPlaceholders('[branch]', ctx)).toBe('jin/fix-login');
	});

	it('resolves missing values to empty and trims', () => {
		expect(expandPlaceholders('  [pr_url]  ', {})).toBe('');
		expect(expandPlaceholders('see [pr_url] now', {})).toBe('see  now');
	});

	it('leaves unknown tokens untouched', () => {
		expect(expandPlaceholders('[nope]', ctx)).toBe('[nope]');
	});
});

describe('contextFromSession', () => {
	it('pulls title/branch/base/cwd/issue/pr off the session', () => {
		const session = {
			title: 'Fix login',
			cwd: '/path/to/project',
			worktree: { repo: '/repo', branch: 'jin/fix-login', createdBranch: true, base: 'main' },
			issue: { source: 'github', id: 'acme#12', url: 'https://example.com/issues/12' },
			pr: { url: 'https://example.com/pull/34', repo: 'acme', number: 34, title: 'Add widget', seenAt: 0 }
		} as DeckSession;
		expect(contextFromSession(session)).toEqual({
			title: 'Fix login',
			branch: 'jin/fix-login',
			base: 'main',
			cwd: '/path/to/project',
			issueId: 'acme#12',
			issueUrl: 'https://example.com/issues/12',
			prUrl: 'https://example.com/pull/34',
			prNumber: '34',
			prTitle: 'Add widget',
			prBranch: 'jin/fix-login',
			prBase: 'main'
		});
	});

	it('leaves fields undefined when no worktree/issue/pr', () => {
		const session = { title: 'Bare', cwd: '/x' } as DeckSession;
		expect(contextFromSession(session)).toEqual({
			title: 'Bare',
			branch: undefined,
			base: undefined,
			cwd: '/x',
			issueId: undefined,
			issueUrl: undefined,
			prUrl: undefined,
			prNumber: undefined,
			prTitle: undefined,
			prBranch: undefined,
			prBase: undefined
		});
	});
});
