import { describe, it, expect } from 'vitest';
import {
	lastPrLink,
	mapPrState,
	buildPrSyncQuery,
	parsePrSyncResponse,
	reviewCounts,
	canMergePr,
	shouldAdminMerge,
	shouldRefreshPrOnOpen,
	PR_OPEN_REFRESH_TTL_MS
} from './pr';
import type { SessionPR } from './types';

describe('lastPrLink', () => {
	it('detects a github PR url and parses owner/repo/number', () => {
		expect(lastPrLink('opened https://github.com/acme/web/pull/42')).toEqual({
			url: 'https://github.com/acme/web/pull/42',
			repo: 'acme/web',
			number: 42
		});
	});

	it('returns the last match when several are present (last-wins)', () => {
		const text =
			'pushed https://github.com/acme/web/pull/1 then https://github.com/acme/web/pull/2';
		expect(lastPrLink(text)?.number).toBe(2);
	});

	it('handles owners and repos with dots and hyphens', () => {
		expect(lastPrLink('https://github.com/my-org.io/deck-app/pull/7')).toEqual({
			url: 'https://github.com/my-org.io/deck-app/pull/7',
			repo: 'my-org.io/deck-app',
			number: 7
		});
	});

	it('stops the number at a fragment or path suffix', () => {
		expect(lastPrLink('https://github.com/acme/web/pull/9/files#diff-1')?.url).toBe(
			'https://github.com/acme/web/pull/9'
		);
		expect(lastPrLink('https://github.com/acme/web/pull/9/files')?.number).toBe(9);
	});

	it('extracts a url embedded in serialized JSON with a trailing quote', () => {
		const line = JSON.stringify({ type: 'text', text: 'see https://github.com/acme/web/pull/12' });
		expect(lastPrLink(line)).toEqual({
			url: 'https://github.com/acme/web/pull/12',
			repo: 'acme/web',
			number: 12
		});
	});

	it('ignores non-github hosts (gitlab, bitbucket)', () => {
		expect(lastPrLink('https://gitlab.com/acme/web/-/merge_requests/3')).toBeNull();
		expect(lastPrLink('https://bitbucket.org/acme/web/pull-requests/3')).toBeNull();
	});

	it('ignores self-hosted / enterprise and look-alike github hosts', () => {
		expect(lastPrLink('https://github.example.com/acme/web/pull/3')).toBeNull();
		expect(lastPrLink('https://github.com.evil.test/acme/web/pull/3')).toBeNull();
		expect(lastPrLink('https://www.github.com/acme/web/pull/3')).toBeNull();
	});

	it('ignores github issue and non-pull urls', () => {
		expect(lastPrLink('https://github.com/acme/web/issues/42')).toBeNull();
		expect(lastPrLink('https://github.com/acme/web/blob/main/pull/x.ts')).toBeNull();
	});

	it('returns null when there is no PR link', () => {
		expect(lastPrLink('no links here')).toBeNull();
		expect(lastPrLink('')).toBeNull();
	});

	it('rejects an out-of-range run of digits rather than truncating it', () => {
		expect(lastPrLink('https://github.com/acme/web/pull/99999999999999999999')).toBeNull();
	});

	it('is reentrant across calls (regex lastIndex not leaked)', () => {
		const text = 'https://github.com/acme/web/pull/5';
		expect(lastPrLink(text)?.number).toBe(5);
		expect(lastPrLink(text)?.number).toBe(5);
	});
});

describe('mapPrState', () => {
	it('maps terminal states regardless of the draft flag', () => {
		expect(mapPrState('MERGED', false)).toBe('merged');
		expect(mapPrState('MERGED', true)).toBe('merged');
		expect(mapPrState('CLOSED', false)).toBe('closed');
		expect(mapPrState('CLOSED', true)).toBe('closed');
	});

	it('distinguishes open from draft via isDraft', () => {
		expect(mapPrState('OPEN', false)).toBe('open');
		expect(mapPrState('OPEN', true)).toBe('draft');
	});

	it('returns null for an unexpected state', () => {
		expect(mapPrState('', false)).toBeNull();
		expect(mapPrState('UNKNOWN', false)).toBeNull();
	});
});

describe('buildPrSyncQuery', () => {
	it('emits one positional alias per ref, splitting owner/repo', () => {
		const q = buildPrSyncQuery([
			{ repo: 'acme/web', number: 34 },
			{ repo: 'my-org.io/deck-app', number: 7 }
		]);
		expect(q).toContain('p0: repository(owner:"acme", name:"web") { pullRequest(number:34)');
		expect(q).toContain('p1: repository(owner:"my-org.io", name:"deck-app") { pullRequest(number:7)');
		expect(q).toContain('mergeStateStatus');
		expect(q).toContain('author{login}');
		expect(q).toContain('latestReviews(first:100){nodes{state}}');
	});

	it('produces a query with no aliases for an empty ref list', () => {
		expect(buildPrSyncQuery([])).toBe('query {\n\n}');
	});
});

describe('reviewCounts', () => {
	it('tallies latest-per-reviewer approvals and change-requests only', () => {
		expect(
			reviewCounts([
				{ state: 'APPROVED' },
				{ state: 'APPROVED' },
				{ state: 'CHANGES_REQUESTED' },
				{ state: 'COMMENTED' },
				{ state: 'DISMISSED' }
			])
		).toEqual({ approvals: 2, changesRequested: 1 });
	});

	it('is zero for no reviews', () => {
		expect(reviewCounts([])).toEqual({ approvals: 0, changesRequested: 0 });
	});
});

describe('canMergePr', () => {
	it('allows a PR you authored', () => {
		expect(canMergePr({ author: 'jinbe' }, 'jinbe')).toBe(true);
	});

	it("rejects someone else's PR when both identities are known", () => {
		expect(canMergePr({ author: 'octocat' }, 'jinbe')).toBe(false);
	});

	it('allows when the author is unknown (older captured PR, not re-synced)', () => {
		expect(canMergePr({ author: undefined }, 'jinbe')).toBe(true);
	});

	it('allows when the viewer identity is unresolved', () => {
		expect(canMergePr({ author: 'octocat' }, null)).toBe(true);
	});
});

describe('shouldAdminMerge', () => {
	it('force-merges only a BLOCKED PR', () => {
		expect(shouldAdminMerge({ mergeStateStatus: 'BLOCKED' })).toBe(true);
		expect(shouldAdminMerge({ mergeStateStatus: 'CLEAN' })).toBe(false);
		expect(shouldAdminMerge({ mergeStateStatus: undefined })).toBe(false);
	});
});

describe('parsePrSyncResponse', () => {
	const node = (over: Record<string, unknown> = {}) => ({
		pullRequest: {
			state: 'OPEN',
			isDraft: false,
			mergeable: 'MERGEABLE',
			mergeStateStatus: 'CLEAN',
			reviewDecision: 'APPROVED',
			author: { login: 'jinbe' },
			latestReviews: { nodes: [{ state: 'APPROVED' }] },
			...over
		}
	});

	it('maps each positional alias onto a patch', () => {
		const raw = JSON.stringify({ data: { p0: node(), p1: node({ state: 'MERGED', mergeable: 'UNKNOWN', mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED', author: { login: 'octocat' }, latestReviews: { nodes: [] } }) } });
		expect(parsePrSyncResponse(raw, 2)).toEqual([
			{ state: 'open', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', author: 'jinbe', approvals: 1, changesRequested: 0 },
			{ state: 'merged', mergeable: 'UNKNOWN', mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED', author: 'octocat', approvals: 0, changesRequested: 0 }
		]);
	});

	it('captures the author login and drops an unknown mergeStateStatus', () => {
		const raw = JSON.stringify({ data: { p0: node({ mergeStateStatus: 'WHATEVER', author: { login: 'octocat' } }) } });
		const patch = parsePrSyncResponse(raw, 1)[0];
		expect(patch?.author).toBe('octocat');
		expect(patch?.mergeStateStatus).toBeUndefined();
	});

	it('leaves the author undefined when the PR has no author node', () => {
		const raw = JSON.stringify({ data: { p0: node({ author: null }) } });
		expect(parsePrSyncResponse(raw, 1)[0]?.author).toBeUndefined();
	});

	it('maps an open draft to the draft state', () => {
		const raw = JSON.stringify({ data: { p0: node({ isDraft: true }) } });
		expect(parsePrSyncResponse(raw, 1)[0]?.state).toBe('draft');
	});

	it('yields null for a missing alias or null pullRequest so last-known state is kept', () => {
		const raw = JSON.stringify({ data: { p0: { pullRequest: null } } });
		expect(parsePrSyncResponse(raw, 2)).toEqual([null, null]);
	});

	it('keeps the good aliases when a partial GraphQL error nulls one (one dead PR does not freeze the chunk)', () => {
		// gh exits non-zero but still writes `data` for the resolvable aliases; the
		// errored alias comes back as { pullRequest: null }.
		const raw = JSON.stringify({
			data: { p0: node(), p1: { pullRequest: null } },
			errors: [{ message: 'Could not resolve to a Repository' }]
		});
		const out = parsePrSyncResponse(raw, 2);
		expect(out[0]).toMatchObject({ state: 'open' });
		expect(out[1]).toBeNull();
	});

	it('coerces an unexpected reviewDecision to null and drops an unknown mergeable', () => {
		const raw = JSON.stringify({ data: { p0: node({ reviewDecision: null, mergeable: 'MERGING' }) } });
		expect(parsePrSyncResponse(raw, 1)[0]).toMatchObject({ reviewDecision: null });
		expect(parsePrSyncResponse(raw, 1)[0]?.mergeable).toBeUndefined();
	});

	it('returns all-null on unparseable output', () => {
		expect(parsePrSyncResponse('not json', 3)).toEqual([null, null, null]);
	});
});

describe('shouldRefreshPrOnOpen', () => {
	const now = 1_000_000;
	const pr = (over: Partial<SessionPR> = {}): SessionPR => ({
		url: 'https://github.com/acme/web/pull/7',
		repo: 'acme/web',
		number: 7,
		seenAt: now,
		...over
	});

	it('skips a session with no captured PR', () => {
		expect(shouldRefreshPrOnOpen(undefined, now)).toBe(false);
	});

	it('skips a merged (terminal) PR', () => {
		expect(shouldRefreshPrOnOpen(pr({ state: 'merged', checkedAt: 0 }), now)).toBe(false);
	});

	it('refreshes open / draft / closed PRs (a closed PR can reopen)', () => {
		for (const state of ['open', 'draft', 'closed'] as const) {
			expect(shouldRefreshPrOnOpen(pr({ state, checkedAt: 0 }), now)).toBe(true);
		}
	});

	it('refreshes a captured-but-never-synced PR (no checkedAt)', () => {
		expect(shouldRefreshPrOnOpen(pr(), now)).toBe(true);
	});

	it('dedupes a PR checked within the TTL', () => {
		expect(shouldRefreshPrOnOpen(pr({ state: 'open', checkedAt: now - 1 }), now)).toBe(false);
		expect(
			shouldRefreshPrOnOpen(pr({ state: 'open', checkedAt: now - (PR_OPEN_REFRESH_TTL_MS - 1) }), now)
		).toBe(false);
	});

	it('refreshes once the TTL has elapsed', () => {
		expect(
			shouldRefreshPrOnOpen(pr({ state: 'open', checkedAt: now - PR_OPEN_REFRESH_TTL_MS }), now)
		).toBe(true);
	});
});
