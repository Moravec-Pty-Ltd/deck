import type { SessionView } from '$lib/session-view';

// The attention-first grouping for the sidebar's "By status" view (issue #48):
// cuts across projects so whatever needs you is up top.
export type StatusBucketKey = 'unread' | 'needs-attention' | 'active' | 'just-finished' | 'idle' | 'dead';

export interface StatusBucket {
	key: StatusBucketKey;
	label: string;
	sessions: SessionView[];
}

// The unread colour (issue #336), teal so it never reads as one of the status
// colours.
export const UNREAD_DOT = 'bg-accent';

// A session row's status dot: primary = running, red = error, a hollow ring for
// dead (so it survives e-ink without colour), neutral for idle. An unread idle
// session takes the unread colour in place of neutral, so marking it read or
// unread never shifts the row (issue #342).
export function statusDotClass(s: Pick<SessionView, 'status' | 'unread'>): string {
	if (s.status === 'running') return 'bg-primary';
	if (s.status === 'error') return 'bg-error';
	if (s.status === 'dead') return 'border border-base-content/40';
	return s.unread ? UNREAD_DOT : 'bg-base-content/35';
}

// The dot colour per bucket, shared by the sidebar and homepage headers. Needs
// attention takes the error colour so it stands out (issue #48), and Just
// finished takes success green to read as "done its turn" next to Idle grey.
export const BUCKET_DOT: Record<StatusBucketKey, string> = {
	unread: UNREAD_DOT,
	'needs-attention': 'bg-error',
	active: 'bg-primary',
	'just-finished': 'bg-success',
	idle: 'bg-base-content/35',
	dead: 'border border-base-content/40'
};

// An idle session counts as "just finished" if it went idle within this window.
const JUST_FINISHED_MS = 15 * 60 * 1000;

// Fixed render order; the label doubles as the header text and collapse key.
const BUCKETS: { key: StatusBucketKey; label: string }[] = [
	{ key: 'unread', label: 'Unread' },
	{ key: 'needs-attention', label: 'Needs attention' },
	{ key: 'active', label: 'Active' },
	{ key: 'just-finished', label: 'Just finished' },
	{ key: 'idle', label: 'Idle' },
	{ key: 'dead', label: 'Dead' }
];

// A session demands attention when it errored or is blocked on an `ask`.
function needsAttention(s: SessionView): boolean {
	return s.status === 'error' || s.awaitingInput === true;
}

// Split the idle case: a recently-idle session lands in "just finished", older
// idle sessions in plain "idle".
function idleBucket(s: SessionView, now: number): StatusBucketKey {
	return now - s.lastActiveAt <= JUST_FINISHED_MS ? 'just-finished' : 'idle';
}

// The bucket a session sorts into. Needs-attention wins over the raw status, so an
// erroring or asking session is pulled out of Active/Idle, and over unread, so a
// question you haven't read stays with the other things waiting on you.
function bucketOf(s: SessionView, now: number): StatusBucketKey {
	if (needsAttention(s)) return 'needs-attention';
	if (s.unread) return 'unread';
	if (s.status === 'running') return 'active';
	if (s.status === 'dead') return 'dead';
	return idleBucket(s, now);
}

// Group sessions into the fixed status buckets, flat within each and most-recent
// first. Empty buckets are dropped so the caller renders only what's populated.
// `now` is threaded so the just-finished window is testable and re-reads each
// poll, letting sessions drift into Idle on their own.
export function bucketSessions(sessions: SessionView[], now = Date.now()): StatusBucket[] {
	const byKey = new Map<StatusBucketKey, SessionView[]>();
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
