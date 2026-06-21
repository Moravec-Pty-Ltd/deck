import webpush, { type PushSubscription } from 'web-push';
import { readJson, writeJson } from './config';

// Web Push so the installed PWA gets notified (question asked, turn ended,
// session crashed/exited) even when it's backgrounded on a phone. VAPID keys and
// subscriptions are persisted under the deck data dir.

const VAPID_FILE = 'vapid.json';
const SUBS_FILE = 'push-subscriptions.json';
// A handful of devices per user is plenty; cap so a caller can't grow the file
// unbounded. When over the cap the newest subscriptions win.
const MAX_SUBS = 20;

interface Vapid {
	publicKey: string;
	privateKey: string;
}

function loadVapid(): Vapid {
	const existing = readJson<Vapid | null>(VAPID_FILE, null);
	if (existing?.publicKey && existing.privateKey) return existing;
	const keys = webpush.generateVAPIDKeys();
	writeJson(VAPID_FILE, keys);
	return keys;
}

const vapid = loadVapid();
export const vapidPublicKey = vapid.publicKey;

// `subject` must be a mailto: or https: URL; the push service only uses it as a
// contact, so a local placeholder is fine.
webpush.setVapidDetails(
	process.env.DECK_PUSH_SUBJECT || 'mailto:deck@localhost',
	vapid.publicKey,
	vapid.privateKey
);

function listSubs(): PushSubscription[] {
	return readJson<PushSubscription[]>(SUBS_FILE, []);
}

// The server POSTs web-push payloads to this endpoint, so require an absolute
// https: URL and reject other schemes/garbage. We deliberately don't allowlist
// hosts: real push endpoints are arbitrary public hosts (self-hosted push
// servers included), so a static host filter would reject legitimate clients.
// The residual is a constrained, authenticated, response-less probe (the body
// is web-push encrypted), an accepted risk for this self-hosted tool.
export function isValidPushEndpoint(endpoint: unknown): endpoint is string {
	if (typeof endpoint !== 'string') return false;
	try {
		return new URL(endpoint).protocol === 'https:';
	} catch {
		return false;
	}
}

export function addSub(sub: PushSubscription) {
	const subs = listSubs().filter((s) => s.endpoint !== sub.endpoint);
	subs.push(sub);
	writeJson(SUBS_FILE, subs.slice(-MAX_SUBS));
}

export function removeSub(endpoint: string) {
	writeJson(
		SUBS_FILE,
		listSubs().filter((s) => s.endpoint !== endpoint)
	);
}

export interface NotifyPayload {
	title: string;
	body?: string;
	url?: string;
	tag?: string;
}

// Fire-and-forget push to every subscription; prune ones the push service has
// expired (404/410).
export function notify(payload: NotifyPayload): void {
	const subs = listSubs();
	if (!subs.length) return;
	const data = JSON.stringify(payload);
	for (const sub of subs) {
		webpush.sendNotification(sub, data).catch((e: { statusCode?: number }) => {
			if (e?.statusCode === 404 || e?.statusCode === 410) removeSub(sub.endpoint);
		});
	}
}
