import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const dataDir = process.env.DECK_DATA ?? path.join(os.homedir(), '.deck');
export const transcriptsDir = path.join(dataDir, 'transcripts');

fs.mkdirSync(transcriptsDir, { recursive: true });

// Auth is optional: deck is meant to sit behind a network boundary (tailnet-only
// `tailscale serve`), which is the real access control. Set DECK_TOKEN to add a
// token wall on top, e.g. on a shared tailnet.
export const authToken: string | null = process.env.DECK_TOKEN || null;

let printed = false;
export function printAccessUrl(origin: string) {
	if (printed) return;
	printed = true;
	const suffix = authToken ? `/?token=${authToken}` : '';
	console.log(`[deck] access: ${origin}${suffix}`);
}

export function readJson<T>(file: string, fallback: T): T {
	try {
		return JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8')) as T;
	} catch {
		return fallback;
	}
}

export function writeJson(file: string, value: unknown) {
	const target = path.join(dataDir, file);
	const tmp = `${target}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(value, null, '\t'));
	fs.renameSync(tmp, target);
}
