// Pure APNs helpers: ES256 JWT assembly, the device registry state machine,
// topic derivation, and deck's push payload -> APNs payload mapping. No node
// imports (no crypto, no fs) so this unit-tests deterministically; the sibling
// apns.ts injects ES256 signing (node:crypto), persistence, and the http2
// transport. Mirrors the pairing-core.ts / pairing.ts split.

import { z } from 'zod';
import { isWorking, JUST_FINISHED_MS } from '$lib/status-groups';
import type { SessionStatus } from '$lib/types';

// `widgets` is the phone's home-screen widget: its own WidgetKit push token,
// which only ever gets a "content changed" push that reloads it.
// `activity-start` is the phone's Live Activity push-to-start token, which
// only ever starts a session's card.
export type ApnsPlatform = 'ios' | 'watchos' | 'macos' | 'widgets' | 'activity-start';
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
	platform: z.enum(['ios', 'watchos', 'macos', 'widgets', 'activity-start']),
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

// The Mac app shares the iOS bundle id, so only the watch and the widget
// pushes get a suffix.
export function deriveTopic(baseTopic: string, platform: ApnsPlatform): string {
	if (platform === 'watchos') return `${baseTopic}.watchkitapp`;
	if (platform === 'widgets') return `${baseTopic}.push-type.widgets`;
	return baseTopic;
}

// Sets the app icon's badge and nothing else, for when sessions are read.
export function badgePayload(count: number) {
	return { aps: { badge: count } };
}

// Only the phone and the Mac show an icon badge.
export function showsBadge(platform: ApnsPlatform): boolean {
	return platform === 'ios' || platform === 'macos';
}

// WidgetKit reloads the widget's timeline on this; it carries no content.
export const WIDGET_PAYLOAD = { aps: { 'content-changed': true } } as const;

// ---- payload mapping ----

// A blocking question riding on its notification, so a client can answer it
// from the notification's actions without opening the app: the ask's ids and
// the first question's option labels (the actions are numbered, since native
// notification actions are registered ahead of time with fixed titles).
export interface PushAsk {
	// Exactly one of these: a session's question, or a blocked workflow run
	// (answered with free text through the run's answer action).
	sessionId?: string;
	runId?: string;
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
	// How many sessions are unread, for the app icon badge.
	badge?: number;
}

export interface ApnsAlert {
	title: string;
	body?: string;
}

export interface ApnsAps {
	alert: ApnsAlert;
	sound: typeof DECK_SOUND;
	'thread-id'?: string;
	category?: string;
	badge?: number;
}

export interface ApnsPayload {
	aps: ApnsAps;
	url?: string;
	ask?: PushAsk;
}

// Bundled in the iPhone, watch and Mac apps (apps/ios/Apps/Sounds) so deck's
// pushes are told apart by ear; a build without the file plays the default.
const DECK_SOUND = 'deck-attention.caf';

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
	const aps: ApnsAps = { alert, sound: DECK_SOUND };
	if (payload.tag !== undefined) aps['thread-id'] = payload.tag;
	if (payload.ask) aps.category = ASK_CATEGORY;
	if (payload.badge !== undefined) aps.badge = payload.badge;
	const result: ApnsPayload = { aps };
	if (payload.url !== undefined) result.url = payload.url;
	if (payload.ask) result.ask = payload.ask;
	return result;
}

// APNs replaces a delivered notification that has the same apns-collapse-id,
// so a session keeps one notification. The header takes at most 64 bytes; a
// longer tag goes through the injected hash (sha256 hex is exactly 64).
export function collapseId(tag: string, hash: (value: string) => string): string {
	return new TextEncoder().encode(tag).length <= 64 ? tag : hash(tag);
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

// Whether a session's card stays live (issue #378): it is working (a turn, or
// subagents after one), asking a question, or errored and not yet read. Any
// other session's card ends, staying on the lock screen through the "just
// finished" window. Waiting on a watch ends like idle; the wake-up starts a
// new card.
export interface ActivitySession {
	status: SessionStatus;
	awaitingInput?: boolean;
	subagents?: number;
	unread?: boolean;
}

export function keepsActivity(s: ActivitySession): boolean {
	return isWorking(s) || s.awaitingInput === true || (s.status === 'error' && s.unread === true);
}

// Only a turn starting or a question starts a card by push, since iOS budgets
// push starts.
export function startsActivity(s: ActivitySession): boolean {
	return keepsActivity(s) && (s.status === 'running' || s.awaitingInput === true);
}

// When an ended card leaves the lock screen: the end of the just-finished
// window after the session went quiet, in epoch seconds.
export function activityDismissAt(lastActiveAtMs: number): number {
	return Math.floor((lastActiveAtMs + JUST_FINISHED_MS) / 1000);
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
// a deleted session's card is dismissed shortly after.
const ACTIVITY_STALE_AFTER_S = 30 * 60;
const ACTIVITY_DISMISS_AFTER_S = 60;

// `dismissAt` (epoch seconds) overrides an end's default short dismissal.
export function toActivityPush(state: ActivityState, event: 'update' | 'end', nowMs: number, dismissAt?: number): ActivityPush {
	const now = Math.floor(nowMs / 1000);
	const aps: ActivityPush['aps'] = { timestamp: now, event, 'content-state': state };
	if (event === 'end') aps['dismissal-date'] = dismissAt ?? now + ACTIVITY_DISMISS_AFTER_S;
	else if (state.status !== 'running') aps['stale-date'] = now + ACTIVITY_STALE_AFTER_S;
	return { aps };
}

// Swift's default Date coding, which ActivityKit decodes attributes with, is
// seconds since 2001-01-01, not the Unix epoch.
const APPLE_EPOCH_OFFSET_S = 978_307_200;

export interface ActivityStartPush {
	aps: {
		timestamp: number;
		event: 'start';
		'content-state': ActivityState;
		'attributes-type': 'SessionActivityAttributes';
		attributes: { sessionId: string; title: string; startedAt: number };
		alert: ApnsAlert;
	};
}

// Starts a session's card by push-to-start; iOS requires the alert, shown
// without a sound.
export function toActivityStartPush(
	session: { id: string; title: string },
	state: ActivityState,
	nowMs: number
): ActivityStartPush {
	return {
		aps: {
			timestamp: Math.floor(nowMs / 1000),
			event: 'start',
			'content-state': state,
			'attributes-type': 'SessionActivityAttributes',
			attributes: { sessionId: session.id, title: session.title, startedAt: nowMs / 1000 - APPLE_EPOCH_OFFSET_S },
			alert: { title: session.title, body: state.awaitingInput ? 'Needs your input' : 'Working' }
		}
	};
}

// A push start registers no token until the phone hands it over, so a second
// trigger in that gap (running, then a question) must not start another card.
export const ACTIVITY_START_GAP_MS = 2 * 60 * 1000;

// A push start waits this long first: the app, when open, starts its own card
// and registers it within a second or two, and a very short turn is over.
export const ACTIVITY_START_DELAY_MS = 10_000;

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
