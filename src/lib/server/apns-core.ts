// Pure APNs helpers: ES256 JWT assembly, the device registry state machine,
// topic derivation, and deck's push payload -> APNs payload mapping. No node
// imports (no crypto, no fs) so this unit-tests deterministically; the sibling
// apns.ts injects ES256 signing (node:crypto), persistence, and the http2
// transport. Mirrors the pairing-core.ts / pairing.ts split.

import { z } from 'zod';

export type ApnsPlatform = 'ios' | 'watchos';
export type ApnsEnv = 'development' | 'production';

export interface ApnsDevice {
	token: string;
	platform: ApnsPlatform;
	env: ApnsEnv;
	addedAt: number;
}

// Apple doesn't publish a fixed device-token length; bound generously rather
// than pin an exact size. Registration input validation lives here (rather
// than the route) so the route stays a thin parse-and-dispatch, matching
// quickmessages.ts's schema.parse -> 400-on-throw pattern.
export const registerDeviceSchema = z.object({
	token: z.string().regex(/^[0-9a-fA-F]{1,200}$/),
	platform: z.enum(['ios', 'watchos']),
	env: z.enum(['development', 'production'])
});

// A handful of devices per user is plenty; cap so a caller can't grow the file
// unbounded. When over the cap the newest devices win (same policy as push.ts).
export const MAX_DEVICES = 20;

export function upsertDevice(list: ApnsDevice[], device: ApnsDevice): ApnsDevice[] {
	const next = list.filter((d) => d.token !== device.token);
	next.push(device);
	return next.slice(-MAX_DEVICES);
}

export function removeDevice(list: ApnsDevice[], token: string): ApnsDevice[] {
	return list.filter((d) => d.token !== token);
}

// ---- base64url (RFC 4648 section 5), no node imports ----

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// Encodes raw bytes as unpadded base64url. Built by hand (rather than reaching
// for node's Buffer) so this file stays importable without any node globals.
export function base64urlEncodeBytes(bytes: Uint8Array): string {
	let out = '';
	for (let i = 0; i < bytes.length; i += 3) {
		const b0 = bytes[i];
		const b1 = bytes[i + 1];
		const b2 = bytes[i + 2];
		out += B64_CHARS[b0 >> 2];
		out += B64_CHARS[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
		out += b1 === undefined ? '' : B64_CHARS[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
		out += b2 === undefined ? '' : B64_CHARS[b2 & 0x3f];
	}
	return out.replace(/\+/g, '-').replace(/\//g, '_');
}

export function base64urlEncodeString(input: string): string {
	return base64urlEncodeBytes(new TextEncoder().encode(input));
}

// ---- ES256 JWT assembly ----
//
// APNs provider tokens are a two-segment JWS (header.claims) plus an ES256
// signature over that pair, all base64url. The signature itself needs an EC
// private key (node:crypto), so `sign` is injected: this file only assembles
// the bytes that get signed and joins the result.

export interface JwtHeader {
	alg: 'ES256';
	kid: string;
}

export interface JwtClaims {
	iss: string;
	iat: number;
}

export function buildJwtHeader(kid: string): JwtHeader {
	return { alg: 'ES256', kid };
}

export function buildJwtClaims(teamId: string, iat: number): JwtClaims {
	return { iss: teamId, iat };
}

export function signingInput(header: JwtHeader, claims: JwtClaims): string {
	return `${base64urlEncodeString(JSON.stringify(header))}.${base64urlEncodeString(JSON.stringify(claims))}`;
}

export function assembleJwt(
	header: JwtHeader,
	claims: JwtClaims,
	sign: (input: string) => string
): string {
	const input = signingInput(header, claims);
	return `${input}.${sign(input)}`;
}

// APNs accepts a provider token reused for 20-60 minutes; regenerate once it's
// older than 45 (mid-window, comfortably inside the bound on either side).
export const JWT_REUSE_MS = 45 * 60 * 1000;

export function shouldRegenerateJwt(issuedAtMs: number | null, nowMs: number): boolean {
	if (issuedAtMs === null) return true;
	return nowMs - issuedAtMs > JWT_REUSE_MS;
}

// ---- topic derivation ----

export function deriveTopic(baseTopic: string, platform: ApnsPlatform): string {
	return platform === 'watchos' ? `${baseTopic}.watchkitapp` : baseTopic;
}

// ---- payload mapping ----

// A blocking question riding on its notification, so a client can answer it
// from the notification's actions without opening the app: the ask's ids and
// the first question's option labels (the actions are numbered, since native
// notification actions are registered ahead of time with fixed titles).
export interface PushAsk {
	sessionId: string;
	askId?: string;
	header?: string;
	options: string[];
	// How many questions the ask holds; option actions only fit a single one.
	questions: number;
}

export interface DeckPushPayload {
	title: string;
	body?: string;
	url?: string;
	tag?: string;
	ask?: PushAsk;
}

export interface ApnsAlert {
	title: string;
	body?: string;
}

export interface ApnsAps {
	alert: ApnsAlert;
	sound: 'default';
	'thread-id'?: string;
	category?: string;
}

export interface ApnsPayload {
	aps: ApnsAps;
	url?: string;
	ask?: PushAsk;
}

// The category the iOS app registers its answer actions under.
export const ASK_CATEGORY = 'DECK_ASK';
// How many option actions the category offers.
export const ASK_ACTION_SLOTS = 3;

// Maps deck's push shape onto an APNs payload; absent optional fields are
// omitted rather than sent as null/undefined. An ask sets the category that
// brings up the answer actions and rides along whole.
export function toApnsPayload(payload: DeckPushPayload): ApnsPayload {
	const alert: ApnsAlert = { title: payload.title };
	if (payload.body !== undefined) alert.body = payload.body;
	const aps: ApnsAps = { alert, sound: 'default' };
	if (payload.tag !== undefined) aps['thread-id'] = payload.tag;
	if (payload.ask) aps.category = ASK_CATEGORY;
	const result: ApnsPayload = { aps };
	if (payload.url !== undefined) result.url = payload.url;
	if (payload.ask) result.ask = payload.ask;
	return result;
}

// The notification body for a question: the question, then its options
// numbered the way the actions are, so "Option 2" on the phone reads as the
// second label here.
export function askNotificationBody(question: string, options: string[]): string {
	if (!options.length) return question;
	const listed = options.slice(0, ASK_ACTION_SLOTS).map((label, i) => `${i + 1} ${label}`).join(' · ');
	return `${question}\n${listed}`;
}

// ---- Live Activity pushes ----

export type ActivityEnv = ApnsEnv;

// A Live Activity's push token, registered by the phone once it starts the
// activity for a session. One activity per session per device.
export interface ActivityToken {
	sessionId: string;
	token: string;
	env: ActivityEnv;
	addedAt: number;
}

export const registerActivitySchema = z.object({
	sessionId: z.string().min(1).max(64),
	token: z.string().regex(/^[0-9a-fA-F]{1,400}$/),
	env: z.enum(['development', 'production'])
});

const MAX_ACTIVITIES = 40;

export function upsertActivity(list: ActivityToken[], entry: ActivityToken): ActivityToken[] {
	const next = list.filter((a) => a.token !== entry.token);
	next.push(entry);
	return next.slice(-MAX_ACTIVITIES);
}

export function removeActivityToken(list: ActivityToken[], token: string): ActivityToken[] {
	return list.filter((a) => a.token !== token);
}

// What the lock-screen card shows; mirrors the ContentState the widget decodes.
export interface ActivityState {
	status: string;
	awaitingInput: boolean;
	// The newest assistant text, trimmed to what a card can hold.
	lastText: string;
	costUsd: number;
	turns: number;
	updatedAt: number;
}

const ACTIVITY_TEXT_CHARS = 160;

export function activityText(text: string | null | undefined): string {
	const flat = (text ?? '').replace(/\s+/g, ' ').trim();
	return flat.length > ACTIVITY_TEXT_CHARS ? `${flat.slice(0, ACTIVITY_TEXT_CHARS - 1)}…` : flat;
}

export interface ActivityPush {
	aps: {
		timestamp: number;
		event: 'update' | 'end';
		'content-state': ActivityState;
		'stale-date'?: number;
		'dismissal-date'?: number;
	};
}

// A finished session's card goes stale after this long (the system dims it);
// an ended session's card is dismissed shortly after.
const ACTIVITY_STALE_AFTER_S = 30 * 60;
const ACTIVITY_DISMISS_AFTER_S = 60;

export function toActivityPush(state: ActivityState, event: 'update' | 'end', nowMs: number): ActivityPush {
	const now = Math.floor(nowMs / 1000);
	const aps: ActivityPush['aps'] = { timestamp: now, event, 'content-state': state };
	if (event === 'end') aps['dismissal-date'] = now + ACTIVITY_DISMISS_AFTER_S;
	else if (state.status !== 'running') aps['stale-date'] = now + ACTIVITY_STALE_AFTER_S;
	return { aps };
}

// Text updates mid-turn are throttled (Apple budgets Live Activity pushes per
// hour); status changes always go through.
export const ACTIVITY_TEXT_INTERVAL_MS = 15_000;

export function shouldPushText(lastTextPushMs: number | undefined, nowMs: number): boolean {
	return lastTextPushMs === undefined || nowMs - lastTextPushMs >= ACTIVITY_TEXT_INTERVAL_MS;
}

// The Live Activity topic is the app's bundle id plus a fixed suffix.
export function activityTopic(baseTopic: string): string {
	return `${baseTopic}.push-type.liveactivity`;
}
