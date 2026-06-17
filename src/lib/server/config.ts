import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const dataDir = process.env.DECK_DATA ?? path.join(os.homedir(), '.deck');
export const transcriptsDir = path.join(dataDir, 'transcripts');

fs.mkdirSync(transcriptsDir, { recursive: true });

const tokenFile = path.join(dataDir, 'token');

function loadToken(): string {
	if (process.env.DECK_TOKEN) return process.env.DECK_TOKEN;
	if (fs.existsSync(tokenFile)) return fs.readFileSync(tokenFile, 'utf8').trim();
	const token = crypto.randomBytes(24).toString('hex');
	fs.writeFileSync(tokenFile, token, { mode: 0o600 });
	return token;
}

export const authToken = loadToken();

// When fronted by Tailscale, the tailnet is the access boundary; the token gate
// is redundant. Set DECK_NO_AUTH=1 to skip it.
export const noAuth = process.env.DECK_NO_AUTH === '1' || process.env.DECK_NO_AUTH === 'true';

let printed = false;
export function printAccessUrl(origin: string) {
	if (printed) return;
	printed = true;
	console.log(noAuth ? `[deck] access: ${origin}/ (no auth)` : `[deck] access: ${origin}/?token=${authToken}`);
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
