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
//   - `code`: a short human-readable code shown on both devices so a person can
//     confirm the request in front of them is the one they're approving. Not a
//     security boundary.

export type PairingStatus = 'pending' | 'approved' | 'denied';

export interface Pairing {
	id: string;
	secret: string;
	code: string;
	createdAt: number;
	expiresAt: number;
	status: PairingStatus;
}

// What a polling requester should do next.
export type ClaimResult = 'approved' | 'pending' | 'denied' | 'expired' | 'unknown';

// Short-lived by design: a request is a live "someone is holding a device asking to
// get in" prompt, not a durable grant.
export const PAIR_TTL_MS = 2 * 60 * 1000;
// Cap concurrent live requests so a burst can't grow the store unbounded; the oldest
// is evicted to make room.
export const MAX_PENDING = 10;

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

// Prune, evict the oldest live requests down to the cap, then append the new one.
export function addPairing(list: Pairing[], p: Pairing, now: number): Pairing[] {
	let next = prune(list, now);
	if (next.length >= MAX_PENDING) {
		next = [...next].sort((a, b) => a.createdAt - b.createdAt).slice(next.length - (MAX_PENDING - 1));
	}
	return [...next, p];
}

// Approve or deny a request by its approver-facing id. Only a live pending request
// transitions; a stale or already-decided one is a no-op (changed: false).
export function decide(
	list: Pairing[],
	id: string,
	status: Exclude<PairingStatus, 'pending'>,
	now: number
): { list: Pairing[]; changed: boolean } {
	let changed = false;
	const next = list.map((p) => {
		if (p.id === id && p.status === 'pending' && !isExpired(p, now)) {
			changed = true;
			return { ...p, status };
		}
		return p;
	});
	return { list: next, changed };
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
