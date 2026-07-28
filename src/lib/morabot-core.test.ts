import { describe, it, expect } from 'vitest';
import type { DeckSession } from '$lib/types';
import {
	deriveReviewsPayload,
	isStale,
	matchSessionForReview,
	parseMorabotStatus,
	reviewMatchesSession,
	selectNewReviews,
	MORABOT_STALE_MS,
	type NotifiedReviews,
	type RecentReview,
	type RecentError
} from './morabot-core';

const NOW = 1_700_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();

const recent = (over: Partial<RecentReview> = {}): RecentReview => ({
	repo: 'acme/web',
	pr: 42,
	headSha: 'abc',
	decision: 'APPROVE',
	reviewId: 1,
	url: 'https://github.com/acme/web/pull/42#pullrequestreview-1',
	reviewedAt: iso(NOW),
	...over
});

const error = (over: Partial<RecentError> = {}): RecentError => ({
	repo: 'acme/web',
	pr: 42,
	headSha: 'abc',
	phase: 'model',
	message: 'Rate limit exceeded',
	url: 'https://github.com/acme/web/pull/42',
	failedAt: iso(NOW),
	...over
});

const session = (over: Partial<DeckSession> = {}): DeckSession =>
	({ id: 's1', pr: { repo: 'acme/web', number: 42, url: 'u', seenAt: 0 }, ...over }) as DeckSession;

describe('parseMorabotStatus', () => {
	it('parses a valid v1 file', () => {
		const parsed = parseMorabotStatus({
			version: 1,
			updatedAt: iso(NOW),
			inFlight: { repo: 'acme/web', pr: 7, headSha: 'ff', phase: 'model', startedAt: iso(NOW) },
			recent: [recent()]
		});
		expect(parsed?.inFlight?.pr).toBe(7);
		expect(parsed?.recent).toHaveLength(1);
	});

	it('returns null for non-objects and missing required fields', () => {
		expect(parseMorabotStatus(null)).toBeNull();
		expect(parseMorabotStatus('nope')).toBeNull();
		expect(parseMorabotStatus({ version: 1 })).toBeNull();
		expect(parseMorabotStatus({ updatedAt: iso(NOW) })).toBeNull();
	});

	it('treats idle (null inFlight) and drops malformed recent entries', () => {
		const parsed = parseMorabotStatus({
			version: 1,
			updatedAt: iso(NOW),
			inFlight: null,
			recent: [recent(), { repo: 'x', pr: 'not-a-number' }, { decision: 'BOGUS' }]
		});
		expect(parsed?.inFlight).toBeNull();
		expect(parsed?.recent).toHaveLength(1);
	});

	it('rejects an unknown decision or phase', () => {
		const parsed = parseMorabotStatus({
			version: 1,
			updatedAt: iso(NOW),
			inFlight: { repo: 'a', pr: 1, headSha: 'h', phase: 'nope', startedAt: iso(NOW) },
			recent: [recent({ decision: 'MERGE' as never })]
		});
		expect(parsed?.inFlight).toBeNull();
		expect(parsed?.recent).toHaveLength(0);
	});

	it('parses recentErrors and drops malformed entries', () => {
		const parsed = parseMorabotStatus({
			version: 1,
			updatedAt: iso(NOW),
			inFlight: null,
			recent: [],
			recentErrors: [
				error(),
				error({ phase: 'prepare' }),
				{ repo: 'x', pr: 'not-a-number' },
				{ phase: 'nope' }
			]
		});
		expect(parsed?.recentErrors).toHaveLength(2);
		expect(parsed?.recentErrors?.[0].phase).toBe('model');
		expect(parsed?.recentErrors?.[1].phase).toBe('prepare');
	});

	it('treats absent recentErrors as an empty list', () => {
		const parsed = parseMorabotStatus({
			version: 1,
			updatedAt: iso(NOW),
			inFlight: null,
			recent: []
		});
		expect(parsed?.recentErrors).toEqual([]);
	});
});

describe('isStale', () => {
	it('is fresh within the threshold and stale beyond it', () => {
		expect(isStale(iso(NOW - 1000), NOW)).toBe(false);
		expect(isStale(iso(NOW - MORABOT_STALE_MS - 1), NOW)).toBe(true);
	});
	it('treats an unparseable date as stale', () => {
		expect(isStale('not a date', NOW)).toBe(true);
	});
});

describe('deriveReviewsPayload', () => {
	it('offline with no data when the file is absent/unparseable', () => {
		expect(deriveReviewsPayload(null, NOW)).toEqual({
			status: 'offline',
			inFlight: null,
			recent: [],
			recentErrors: []
		});
	});

	it('ok with in-flight for a fresh snapshot', () => {
		const payload = deriveReviewsPayload(
			{
				version: 1,
				updatedAt: iso(NOW),
				inFlight: { repo: 'a', pr: 1, headSha: 'h', phase: 'context', startedAt: iso(NOW) },
				recent: [recent()]
			},
			NOW
		);
		expect(payload.status).toBe('ok');
		expect(payload.inFlight?.pr).toBe(1);
	});

	it('offline keeps recent but drops in-flight when stale', () => {
		const payload = deriveReviewsPayload(
			{
				version: 1,
				updatedAt: iso(NOW - MORABOT_STALE_MS - 1),
				inFlight: { repo: 'a', pr: 1, headSha: 'h', phase: 'context', startedAt: iso(NOW) },
				recent: [recent()],
				recentErrors: [error()]
			},
			NOW
		);
		expect(payload.status).toBe('offline');
		expect(payload.inFlight).toBeNull();
		expect(payload.recent).toHaveLength(1);
		expect(payload.recentErrors).toHaveLength(1);
	});

	it('includes recentErrors in the payload', () => {
		const payload = deriveReviewsPayload(
			{
				version: 1,
				updatedAt: iso(NOW),
				inFlight: null,
				recent: [],
				recentErrors: [error()]
			},
			NOW
		);
		expect(payload.status).toBe('ok');
		expect(payload.recentErrors).toHaveLength(1);
	});
});

describe('matching', () => {
	it('matches on repo and number', () => {
		expect(reviewMatchesSession(recent(), session())).toBe(true);
		expect(reviewMatchesSession(recent({ pr: 99 }), session())).toBe(false);
		expect(reviewMatchesSession(recent({ repo: 'other/repo' }), session())).toBe(false);
	});
	it('finds the first matching session or null', () => {
		const sessions = [session({ id: 'a', pr: undefined }), session({ id: 'b' })];
		expect(matchSessionForReview(recent(), sessions)?.id).toBe('b');
		expect(matchSessionForReview(recent({ pr: 1 }), sessions)).toBeNull();
	});
});

describe('selectNewReviews', () => {
	it('returns only ids not already in the ledger', () => {
		const notified: NotifiedReviews = { '1': NOW };
		const fresh = selectNewReviews([recent({ reviewId: 1 }), recent({ reviewId: 2 })], notified);
		expect(fresh.map((r) => r.reviewId)).toEqual([2]);
	});
});
