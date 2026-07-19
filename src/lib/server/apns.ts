import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http2 from 'node:http2';
import { dataDir, readJson, writeJson } from './config';
import * as core from './apns-core';

// APNs (Apple Push Notification service) so native iOS/watchOS clients get
// the same nudges the installed PWA gets over web push (question asked, turn
// ended, session crashed/exited). Config and the device registry are
// persisted under the deck data dir, mirroring push.ts/pairing.ts.

const CONFIG_FILE = 'apns.json';
const DEVICES_FILE = 'apns-devices.json';

const DEFAULT_TOPIC = 'tech.moravec.deck';

interface ApnsFileConfig {
	keyId?: string;
	teamId?: string;
	topic?: string;
	keyPath?: string;
}

interface ResolvedConfig {
	keyId: string;
	teamId: string;
	topic: string;
	keyPath: string;
}

// Env overrides > ~/.deck/apns.json > defaults. `keyPath` defaults alongside
// the rest of deck's data (respects a DECK_DATA override in tests).
function resolveConfig(): ResolvedConfig {
	const file = readJson<ApnsFileConfig>(CONFIG_FILE, {});
	return {
		keyId: process.env.DECK_APNS_KEY_ID?.trim() || file.keyId || '',
		teamId: process.env.DECK_APNS_TEAM_ID?.trim() || file.teamId || '',
		topic: process.env.DECK_APNS_TOPIC?.trim() || file.topic || DEFAULT_TOPIC,
		keyPath:
			process.env.DECK_APNS_KEY_PATH?.trim() || file.keyPath || path.join(dataDir, 'apns-key.p8')
	};
}

function loadSigningKey(keyPath: string): string | null {
	try {
		return fs.readFileSync(keyPath, 'utf8');
	} catch {
		return null;
	}
}

const config = resolveConfig();
const signingKey = loadSigningKey(config.keyPath);

// Silently disabled when the key file or keyId is missing, same as push.ts
// with no subscriptions - logged once here (not per send) so it's visible at
// startup without spamming every notify() call.
const apnsEnabled = Boolean(signingKey && config.keyId && config.teamId);
if (!apnsEnabled) {
	console.log(
		!signingKey
			? `[deck] APNs disabled: no key file at ${config.keyPath}`
			: '[deck] APNs disabled: keyId and teamId are required (DECK_APNS_* or apns.json)'
	);
}

// ---- device registry persistence ----

function loadDevices(): core.ApnsDevice[] {
	return readJson<core.ApnsDevice[]>(DEVICES_FILE, []);
}

function saveDevices(list: core.ApnsDevice[]) {
	writeJson(DEVICES_FILE, list, 0o600);
}

// Throws (a ZodError) on invalid input; the route catches it and returns 400.
export function registerDevice(raw: unknown) {
	const input = core.registerDeviceSchema.parse(raw);
	saveDevices(core.upsertDevice(loadDevices(), { ...input, addedAt: Date.now() }));
}

export function unregisterDevice(token: string) {
	saveDevices(core.removeDevice(loadDevices(), token));
}

// ---- JWT signing + caching ----

function sign(input: string): string {
	// ieee-p1363 gives the raw r||s signature JOSE/APNs expects, rather than
	// node's default DER encoding.
	const signature = crypto.sign('sha256', Buffer.from(input, 'utf8'), {
		key: signingKey as string,
		dsaEncoding: 'ieee-p1363'
	});
	return core.base64urlEncodeBytes(signature);
}

let cachedJwt: { token: string; issuedAt: number } | null = null;

function currentJwt(): string | null {
	if (!signingKey) return null;
	const now = Date.now();
	if (cachedJwt && !core.shouldRegenerateJwt(cachedJwt.issuedAt, now)) return cachedJwt.token;
	const header = core.buildJwtHeader(config.keyId);
	const claims = core.buildJwtClaims(config.teamId, Math.floor(now / 1000));
	cachedJwt = { token: core.assembleJwt(header, claims, sign), issuedAt: now };
	return cachedJwt.token;
}

// ---- http2 transport ----

function apnsHost(env: core.ApnsEnv): string {
	return env === 'production' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com';
}

// One session per host, reused across sends; dropped on error/GOAWAY/close so
// the next send reconnects instead of retrying a dead session.
const sessions = new Map<string, http2.ClientHttp2Session>();

function sessionFor(env: core.ApnsEnv): http2.ClientHttp2Session {
	const host = apnsHost(env);
	const existing = sessions.get(host);
	if (existing && !existing.closed && !existing.destroyed) return existing;
	const session = http2.connect(`https://${host}:443`);
	const drop = () => sessions.delete(host);
	session.on('error', drop);
	session.on('goaway', drop);
	session.on('close', drop);
	sessions.set(host, session);
	return session;
}

// A 410, or a 4xx reason saying the token is dead, means the device will
// never accept another push - prune it. Anything else is logged (no token in
// the log; the token itself is the secret).
function handleFailureStatus(device: core.ApnsDevice, status: number, reason: string | undefined) {
	if (status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered') {
		unregisterDevice(device.token);
		return;
	}
	console.error(
		`[deck] APNs send failed (status ${status}${reason ? `, reason ${reason}` : ''}) for a ${device.platform}/${device.env} device`
	);
}

function parseReason(body: string): string | undefined {
	try {
		return (JSON.parse(body) as { reason?: string }).reason;
	} catch {
		return undefined;
	}
}

// A stream/session-level throw (e.g. the session died between the health
// check in sessionFor and this call) is caught here rather than propagating,
// so one device's connection trouble can't take down the whole notify fan-out.
function sendToDevice(device: core.ApnsDevice, payload: core.ApnsPayload): Promise<void> {
	const jwt = currentJwt();
	if (!jwt) return Promise.resolve();
	return new Promise((resolve) => {
		const fail = (err: unknown) => {
			console.error(`[deck] APNs send failed for a ${device.platform}/${device.env} device:`, err);
			resolve();
		};
		try {
			const req = sessionFor(device.env).request({
				':method': 'POST',
				':path': `/3/device/${device.token}`,
				authorization: `bearer ${jwt}`,
				'apns-topic': core.deriveTopic(config.topic, device.platform),
				'apns-push-type': 'alert',
				'apns-priority': '10',
				'apns-expiration': '0'
			});
			let status = 0;
			let body = '';
			req.on('response', (headers) => {
				status = Number(headers[':status']) || 0;
			});
			req.setEncoding('utf8');
			req.on('data', (chunk: string) => (body += chunk));
			req.on('end', () => {
				if (status >= 400) handleFailureStatus(device, status, parseReason(body));
				resolve();
			});
			req.on('error', fail);
			req.end(JSON.stringify(payload));
		} catch (err) {
			fail(err);
		}
	});
}

// Fire-and-forget push to every registered device; never throws, mirroring
// push.ts's notify(). A no-op when APNs isn't configured or no devices are
// registered.
export async function apnsNotify(payload: core.DeckPushPayload): Promise<void> {
	if (!apnsEnabled) return;
	try {
		const devices = loadDevices();
		if (!devices.length) return;
		const apnsPayload = core.toApnsPayload(payload);
		await Promise.all(devices.map((d) => sendToDevice(d, apnsPayload)));
	} catch (err) {
		console.error('[deck] apnsNotify failed:', err);
	}
}
