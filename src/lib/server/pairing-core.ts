// Pure pairing-code state machine (issue #150): TTL expiry, single-use consumption,
// and the pending -> approved/denied transitions. Node-free (no fs, no crypto, no
// clock) so it unit-tests deterministically; the sibling pairing.ts injects the
// randomness (id/secret/code), the clock, and persistence.
//
// Three identifiers per request, each with a distinct job:
//   - `secret`: high-entropy, returned only to the requesting device, used to poll
//     status and receive the cookie. High entropy so it can't be brute-forced.
//   - `id`: returned only to the approving (authenticated) browser in the pending
//     list; approve/deny reference it. Kept apart from `secret` so the approver
//     never learns the requester's polling handle.
//   - `code`: a short code shown only on the requesting device. The approver types
//     it, so they can't approve a device they aren't looking at.

export type PairingStatus = 'pending' | 'approved' | 'denied';

export interface Pairing {
	id: string;
	secret: string;
	code: string;
	createdAt: number;
	expiresAt: number;
	status: PairingStatus;
	// Wrong codes typed for it so far.
	wrong?: number;
}

// What a polling requester should do next.
export type ClaimResult = 'approved' | 'pending' | 'denied' | 'expired' | 'unknown';

// Short-lived by design: a request is a live "someone is holding a device asking to
// get in" prompt, not a durable grant.
export const PAIR_TTL_MS = 2 * 60 * 1000;
// Cap concurrent live requests so a burst can't grow the store unbounded. Past it a
// new one is refused: making room would drop a request someone is waiting on.
export const MAX_PENDING = 10;
// How many may be made in a minute, over all devices: the route is public.
export const MAX_PER_MINUTE = 5;
export const MAX_WRONG_CODES = 5;

// Whether one more may be made now, given when recent ones were.
export function mayRequest(recent: number[], now: number): boolean {
	return recent.filter((at) => now - at < 60_000).length < MAX_PER_MINUTE;
}

export function isExpired(p: Pairing, now: number): boolean {
	return now >= p.expiresAt;
}

export function makePairing(parts: Pick<Pairing, 'id' | 'secret' | 'code'>, now: number): Pairing {
	return { ...parts, createdAt: now, expiresAt: now + PAIR_TTL_MS, status: 'pending' };
}

// Drop expired records (of any status). Called before every read/write so callers
// never see a stale request.
export function prune(list: Pairing[], now: number): Pairing[] {
	return list.filter((p) => !isExpired(p, now));
}

export function activePending(list: Pairing[], now: number): Pairing[] {
	return list.filter((p) => p.status === 'pending' && !isExpired(p, now));
}

// Whether a display code is already taken by a live request (the sibling retries
// generation on collision so a person never sees two live requests share a code).
export function codeInUse(list: Pairing[], code: string, now: number): boolean {
	return list.some((p) => p.code === code && !isExpired(p, now));
}

// Prune, then append the new one; null when the queue is full.
export function addPairing(list: Pairing[], p: Pairing, now: number): Pairing[] | null {
	const next = prune(list, now);
	return next.length < MAX_PENDING ? [...next, p] : null;
}

export type Decision = 'ok' | 'gone' | 'wrong-code';

// Deny a request, or approve it with its code, by its approver-facing id. Only a
// live pending request transitions; a stale or already-decided one is 'gone'. Too
// many wrong codes deny it.
export function decide(list: Pairing[], id: string, approve: { code: string } | null, now: number): { list: Pairing[]; result: Decision; status?: PairingStatus } {
	const found = list.find((p) => p.id === id && p.status === 'pending' && !isExpired(p, now));
	if (!found) return { list, result: 'gone' };
	const put = (next: Partial<Pairing>) => list.map((p) => (p === found ? { ...p, ...next } : p));
	if (!approve) return { list: put({ status: 'denied' }), result: 'ok', status: 'denied' };
	if (approve.code === found.code) return { list: put({ status: 'approved' }), result: 'ok', status: 'approved' };
	const wrong = (found.wrong ?? 0) + 1;
	const status = wrong >= MAX_WRONG_CODES ? 'denied' : 'pending';
	return { list: put({ wrong, status }), result: 'wrong-code', status };
}

// Resolve a requester's poll by its secret. A terminal state (approved/denied) is
// consumed - removed from the list - so it's strictly single-use: a replayed poll
// after an approval can't re-authenticate.
export function consumeBySecret(
	list: Pairing[],
	secret: string,
	now: number
): { list: Pairing[]; result: ClaimResult } {
	const found = list.find((p) => p.secret === secret);
	if (!found) return { list, result: 'unknown' };
	if (isExpired(found, now)) return { list: prune(list, now), result: 'expired' };
	if (found.status === 'pending') return { list, result: 'pending' };
	return { list: list.filter((p) => p !== found), result: found.status };
}
