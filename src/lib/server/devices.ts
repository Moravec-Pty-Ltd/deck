import { readJson, tokenMatches, writeJson } from './config';
import { deviceFor, mintDevice, SEEN_EVERY_MS, type Device } from './devices-core';

// The signed-in devices (S9), in ~/.deck/devices.json (mode 0600). Read once and
// kept in memory: every request checks a credential against it.
const FILE = 'devices.json';
const g = globalThis as { __deckDevices?: Device[] };

function devices(): Device[] {
	if (!g.__deckDevices) {
		const read = readJson<unknown>(FILE, []);
		const list = Array.isArray(read) ? (read as Partial<Device>[]) : [];
		g.__deckDevices = list.filter((d): d is Device => typeof d?.id === 'string' && typeof d.hash === 'string');
	}
	return g.__deckDevices;
}

function save(list: Device[]): void {
	g.__deckDevices = list;
	writeJson(FILE, list, 0o600);
}

export function listDevices(): Device[] {
	return devices();
}

// A new device and the credential to hand it; the credential is never stored.
export function addDevice(name: string): { device: Device; credential: string } {
	const minted = mintDevice(name, Date.now());
	save([...devices(), minted.device]);
	return minted;
}

export function revokeDevice(id: string): boolean {
	const list = devices();
	const next = list.filter((d) => d.id !== id);
	if (next.length === list.length) return false;
	save(next);
	return true;
}

// The device a credential belongs to, noting when it was last seen.
export function deviceForCredential(credential: string | null | undefined): Device | null {
	const device = deviceFor(devices(), credential);
	if (device && Date.now() - (device.lastSeenAt ?? 0) > SEEN_EVERY_MS) {
		save(devices().map((d) => (d.id === device.id ? { ...d, lastSeenAt: Date.now() } : d)));
	}
	return device;
}

// What a login hands the browser: a device credential signs it in as that
// device (the sign-in QR's), deck's token as a new one; anything else, nothing.
export function signInCredential(token: string, userAgent: string | null): string | null {
	if (deviceForCredential(token)) return token;
	return tokenMatches(token) ? addDevice(userAgent ?? 'Browser').credential : null;
}
