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

export interface DeckPushPayload {
	title: string;
	body?: string;
	url?: string;
	tag?: string;
}

export interface ApnsAlert {
	title: string;
	body?: string;
}

export interface ApnsAps {
	alert: ApnsAlert;
	sound: 'default';
	'thread-id'?: string;
}

export interface ApnsPayload {
	aps: ApnsAps;
	url?: string;
}

// Maps deck's push shape onto an APNs payload; absent optional fields are
// omitted rather than sent as null/undefined.
export function toApnsPayload(payload: DeckPushPayload): ApnsPayload {
	const alert: ApnsAlert = { title: payload.title };
	if (payload.body !== undefined) alert.body = payload.body;
	const aps: ApnsAps = { alert, sound: 'default' };
	if (payload.tag !== undefined) aps['thread-id'] = payload.tag;
	const result: ApnsPayload = { aps };
	if (payload.url !== undefined) result.url = payload.url;
	return result;
}
