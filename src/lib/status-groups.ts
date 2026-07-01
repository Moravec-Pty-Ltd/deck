import type { DeckSession } from '$lib/types';

// The attention-first grouping for the sidebar's "By status" view (issue #48):
// cuts across projects so whatever needs you is up top.
export type StatusBucketKey = 'needs-attention' | 'active' | 'just-finished' | 'idle' | 'dead';

export interface StatusBucket {
	key: StatusBucketKey;
	label: string;
	sessions: DeckSession[];
}

// An idle session counts as "just finished" if it went idle within this window.
const JUST_FINISHED_MS = 15 * 60 * 1000;

// Fixed render order; the label doubles as the header text and collapse key.
const BUCKETS: { key: StatusBucketKey; label: string }[] = [
	{ key: 'needs-attention', label: 'Needs attention' },
	{ key: 'active', label: 'Active' },
	{ key: 'just-finished', label: 'Just finished' },
	{ key: 'idle', label: 'Idle' },
	{ key: 'dead', label: 'Dead' }
];

// A session demands attention when it errored or is blocked on an `ask`.
function needsAttention(s: DeckSession): boolean {
	return s.status === 'error' || s.awaitingInput === true;
}

// Split the idle case: a recently-idle session lands in "just finished", older
// idle sessions in plain "idle".
function idleBucket(s: DeckSession, now: number): StatusBucketKey {
	return now - s.lastActiveAt <= JUST_FINISHED_MS ? 'just-finished' : 'idle';
}

// The bucket a session sorts into. Needs-attention wins over the raw status, so an
// erroring or asking session is pulled out of Active/Idle.
function bucketOf(s: DeckSession, now: number): StatusBucketKey {
	if (needsAttention(s)) return 'needs-attention';
	if (s.status === 'running') return 'active';
	if (s.status === 'dead') return 'dead';
	return idleBucket(s, now);
}

// Group sessions into the fixed status buckets, flat within each and most-recent
// first. Empty buckets are dropped so the caller renders only what's populated.
// `now` is threaded so the just-finished window is testable and re-reads each
// poll, letting sessions drift into Idle on their own.
export function bucketSessions(sessions: DeckSession[], now = Date.now()): StatusBucket[] {
	const byKey = new Map<StatusBucketKey, DeckSession[]>();
	for (const s of sessions) {
		const key = bucketOf(s, now);
		const list = byKey.get(key);
		if (list) list.push(s);
		else byKey.set(key, [s]);
	}
	return BUCKETS.flatMap(({ key, label }) => {
		const list = byKey.get(key);
		if (!list) return [];
		list.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
		return [{ key, label, sessions: list }];
	});
}
