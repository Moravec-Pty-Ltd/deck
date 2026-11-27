import crypto from 'node:crypto';

// A signed-in device's own credential (issue #441, S9): `deck-device.<id>.<secret>`,
// kept by the device (a cookie, or an app's Keychain) and stored here only as a
// hash, so one device can be revoked without signing out the rest.

export interface Device {
	id: string;
	name: string;
	createdAt: number;
	lastSeenAt?: number;
	hash: string;
}

const CREDENTIAL = /^deck-device\.([\w-]{12})\.([\w-]{43})$/;

function hashSecret(secret: string): string {
	return crypto.createHash('sha256').update(secret).digest('hex');
}

export function mintDevice(name: string, now: number): { device: Device; credential: string } {
	const id = crypto.randomBytes(9).toString('base64url');
	const secret = crypto.randomBytes(32).toString('base64url');
	return {
		device: { id, name: deviceName(name), createdAt: now, hash: hashSecret(secret) },
		credential: `deck-device.${id}.${secret}`
	};
}

// Whether a request may swap a cookie holding deck's token for a device's own:
// a browser's page load, never an API call.
export function upgradesCookie(method: string, fetchMode: string | null): boolean {
	return method === 'GET' && fetchMode === 'navigate';
}

// The device a credential belongs to, or null.
export function deviceFor(devices: Device[], credential: string | null | undefined): Device | null {
	const m = typeof credential === 'string' ? CREDENTIAL.exec(credential) : null;
	const device = m ? devices.find((d) => d.id === m[1]) : undefined;
	if (!m || !device) return null;
	const want = Buffer.from(device.hash, 'hex');
	const got = Buffer.from(hashSecret(m[2]), 'hex');
	return want.length === got.length && crypto.timingSafeEqual(want, got) ? device : null;
}

// A short label from what the device said it is: a user agent, or a name.
export function deviceName(raw: string): string {
	const text = raw.replace(/\s+/g, ' ').trim();
	const known = /(iPhone|iPad|Macintosh|Android|Linux|Windows)/.exec(text)?.[1];
	const browser = /(Firefox|Edg|Chrome|Safari)\//.exec(text)?.[1];
	if (known) return browser ? `${browser === 'Edg' ? 'Edge' : browser} on ${known === 'Macintosh' ? 'Mac' : known}` : known;
	return text.slice(0, 60) || 'Device';
}

// lastSeenAt is written at most this often, so every request doesn't rewrite the file.
export const SEEN_EVERY_MS = 10 * 60_000;
