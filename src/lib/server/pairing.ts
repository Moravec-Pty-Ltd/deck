import crypto from 'node:crypto';
import { readJson, writeJson } from './config';
import { notify } from './push';
import * as core from './pairing-core';

// Persistence + randomness + the always-on push nudge for the pure pairing state
// machine in pairing-core.ts. The store is a small JSON file of live requests under
// the deck data dir; every path prunes expired entries first.

const FILE = 'pairing.json';

function load(): core.Pairing[] {
	return readJson<core.Pairing[]>(FILE, []);
}

function save(list: core.Pairing[]) {
	// Holds requester secrets (a claimed secret sets the session cookie), so persist
	// 0o600 like the token file rather than at the umask default.
	writeJson(FILE, list, 0o600);
}

// Six digits, zero-padded, from a uniform source (randomInt avoids the modulo bias
// of randomBytes % 1e6).
function newCode(): string {
	return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

// /api/pair/request is unauthenticated, so throttle the push nudge: a burst of
// requests can't spam every device (or trip the push provider's rate limit). The
// request is still stored and still surfaces in the authenticated home poll; only
// the push is coalesced.
const PUSH_COOLDOWN_MS = 15_000;
let lastPushAt = 0;

export interface PairingRequest {
	secret: string;
	code: string;
	expiresAt: number;
}

// A new device asks for access: mint a request, persist it, and nudge existing
// devices via web push (the only always-on channel). Returns the requester its
// polling secret and the display code; never the approver-facing id.
export function requestPairing(): PairingRequest {
	const now = Date.now();
	let list = core.prune(load(), now);
	let code = newCode();
	while (core.codeInUse(list, code, now)) code = newCode();
	const record = core.makePairing(
		{
			id: crypto.randomBytes(9).toString('hex'),
			secret: crypto.randomBytes(24).toString('hex'),
			code
		},
		now
	);
	list = core.addPairing(list, record, now);
	save(list);
	if (now - lastPushAt > PUSH_COOLDOWN_MS) {
		lastPushAt = now;
		notify({
			title: 'deck: device wants access',
			body: `Approve code ${code}? Open deck to allow or deny.`,
			url: '/',
			tag: 'deck-pairing'
		});
	}
	return { secret: record.secret, code: record.code, expiresAt: record.expiresAt };
}

export interface PendingPairing {
	id: string;
	code: string;
}

// The live requests an authenticated browser may approve: just the approver-facing
// id and the code to eyeball. The requester's secret is never included.
export function listPending(): PendingPairing[] {
	const now = Date.now();
	const list = load();
	const pruned = core.prune(list, now);
	if (pruned.length !== list.length) save(pruned);
	return core.activePending(pruned, now).map(({ id, code }) => ({ id, code }));
}

// Approve or deny a request by its id (from an authenticated browser). Returns
// whether a live request actually transitioned.
export function decidePairing(id: string, approve: boolean): boolean {
	const now = Date.now();
	const loaded = load();
	const pruned = core.prune(loaded, now);
	const { list, changed } = core.decide(pruned, id, approve ? 'approved' : 'denied', now);
	if (changed || pruned.length !== loaded.length) save(list);
	return changed;
}

// A requester polls with its secret. On a terminal result the record is consumed
// (single-use); the caller sets the cookie when the result is 'approved'.
export function claimPairing(secret: string): core.ClaimResult {
	const now = Date.now();
	const { list, result } = core.consumeBySecret(load(), secret, now);
	// Persist consumption (approved/denied removal) and any pruning of an expired hit.
	if (result === 'approved' || result === 'denied' || result === 'expired') save(list);
	return result;
}
