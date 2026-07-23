// Pure parsing / matching / state-derivation for the morabot integration (issue
// #188), kept node-free so it unit-tests without fs. morabot is our PR-review bot;
// it writes an atomically-updated status.json deck polls (read-only). The
// orchestration (path confinement, file reads, notifications, durable ledger)
// lives in the sibling morabot.ts.
import type { DeckSession } from '$lib/types';

// morabot's poll cadence and the staleness threshold. updatedAt refreshes every
// cycle, so no refresh for >3x the interval means the bot is offline and its
// snapshot must not be presented as live.
const MORABOT_POLL_INTERVAL_MS = 300_000;
export const MORABOT_STALE_MS = MORABOT_POLL_INTERVAL_MS * 3;

export type ReviewDecision = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
export type ReviewPhase = 'context' | 'model' | 'posting';

// The review morabot is working on right now; null in the file when idle.
export interface InFlightReview {
	repo: string;
	pr: number;
	headSha: string;
	phase: ReviewPhase;
	startedAt: string;
}

// A finished review, recorded after the GitHub review posts.
export interface RecentReview {
	repo: string;
	pr: number;
	headSha: string;
	decision: ReviewDecision;
	reviewId: number;
	url: string;
	reviewedAt: string;
}

// The status.json contract, version 1.
export interface MorabotStatus {
	version: number;
	updatedAt: string;
	inFlight: InFlightReview | null;
	recent: RecentReview[];
}

// What the client sees. `unconfigured` hides the sidebar section entirely (env
// unset); `offline` covers absent / unparseable / stale (bot never ran or stopped)
// and suppresses any in-flight so a stale spinner never reads as live; `ok` is a
// fresh snapshot.
export type ReviewsStatus = 'ok' | 'offline' | 'unconfigured';

export interface ReviewsPayload {
	status: ReviewsStatus;
	updatedAt?: string;
	inFlight: InFlightReview | null;
	recent: RecentReview[];
}

const PHASES: ReviewPhase[] = ['context', 'model', 'posting'];
const DECISIONS: ReviewDecision[] = ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'];

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null;
}

function parseInFlight(v: unknown): InFlightReview | null {
	if (!isObj(v)) return null;
	const { repo, pr, headSha, phase, startedAt } = v;
	if (typeof repo !== 'string' || typeof pr !== 'number') return null;
	if (typeof headSha !== 'string' || typeof startedAt !== 'string') return null;
	if (!PHASES.includes(phase as ReviewPhase)) return null;
	return { repo, pr, headSha, phase: phase as ReviewPhase, startedAt };
}

function parseRecent(v: unknown): RecentReview | null {
	if (!isObj(v)) return null;
	const { repo, pr, headSha, decision, reviewId, url, reviewedAt } = v;
	if (typeof repo !== 'string' || typeof pr !== 'number') return null;
	if (typeof headSha !== 'string' || typeof reviewId !== 'number') return null;
	if (typeof url !== 'string' || typeof reviewedAt !== 'string') return null;
	if (!DECISIONS.includes(decision as ReviewDecision)) return null;
	return { repo, pr, headSha, decision: decision as ReviewDecision, reviewId, url, reviewedAt };
}

// Parse the raw file contents defensively: return null if it isn't the expected
// shape, and drop individual malformed `recent` entries rather than rejecting the
// whole file. A single-user local file, but it's produced by another process, so
// treat it as untrusted input.
export function parseMorabotStatus(raw: unknown): MorabotStatus | null {
	if (!isObj(raw)) return null;
	if (typeof raw.version !== 'number' || typeof raw.updatedAt !== 'string') return null;
	const recent = Array.isArray(raw.recent)
		? raw.recent.map(parseRecent).filter((r): r is RecentReview => r !== null)
		: [];
	return {
		version: raw.version,
		updatedAt: raw.updatedAt,
		inFlight: parseInFlight(raw.inFlight),
		recent
	};
}

// A snapshot is stale when its updatedAt is older than the staleness threshold (or
// unparseable as a date). now is a ms epoch.
export function isStale(updatedAt: string, now: number, thresholdMs = MORABOT_STALE_MS): boolean {
	const t = Date.parse(updatedAt);
	if (Number.isNaN(t)) return true;
	return now - t > thresholdMs;
}

// The client payload for a *configured* integration, from the parsed status (null
// when the file is absent/unparseable) and the current time. Absent or stale both
// render as `offline`; a stale file keeps its recent list (for context) but never
// its in-flight review.
export function deriveReviewsPayload(parsed: MorabotStatus | null, now: number): ReviewsPayload {
	if (!parsed) return { status: 'offline', inFlight: null, recent: [] };
	if (isStale(parsed.updatedAt, now)) {
		return { status: 'offline', updatedAt: parsed.updatedAt, inFlight: null, recent: parsed.recent };
	}
	return {
		status: 'ok',
		updatedAt: parsed.updatedAt,
		inFlight: parsed.inFlight,
		recent: parsed.recent
	};
}

// Does a review's repo#pr match a session's captured PR?
export function reviewMatchesSession(
	review: Pick<RecentReview, 'repo' | 'pr'>,
	session: Pick<DeckSession, 'pr'>
): boolean {
	return session.pr?.repo === review.repo && session.pr?.number === review.pr;
}

// The first session whose captured PR matches this review, or null. Used both to
// link a recent review to a session and to target a notification.
export function matchSessionForReview<T extends Pick<DeckSession, 'id' | 'pr'>>(
	review: Pick<RecentReview, 'repo' | 'pr'>,
	sessions: T[]
): T | null {
	return sessions.find((s) => reviewMatchesSession(review, s)) ?? null;
}

// The durable ledger of review ids already notified (or baselined), keyed to their
// first-seen timestamp so a restart never re-notifies.
export type NotifiedReviews = Record<string, number>;

export function reviewNotifyKey(reviewId: number): string {
	return String(reviewId);
}

// Recent reviews whose id isn't in the ledger yet — the candidates for a fresh
// notification (or, on first run, the baseline to seed silently).
export function selectNewReviews(recent: RecentReview[], notified: NotifiedReviews): RecentReview[] {
	return recent.filter((r) => notified[reviewNotifyKey(r.reviewId)] === undefined);
}

export function decisionLabel(decision: ReviewDecision): string {
	if (decision === 'APPROVE') return 'Approved';
	if (decision === 'REQUEST_CHANGES') return 'Changes requested';
	return 'Commented';
}

export function phaseLabel(phase: ReviewPhase): string {
	if (phase === 'context') return 'Gathering context';
	if (phase === 'model') return 'Reviewing';
	return 'Posting';
}
