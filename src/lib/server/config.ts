import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DEMO } from './demo';

const dataDir = process.env.DECK_DATA ?? path.join(os.homedir(), '.deck');
export const transcriptsDir = path.join(dataDir, 'transcripts');
// Per-session resume files for per-turn agents (pi session files, etc).
export const agentSessionsDir = path.join(dataDir, 'agent-sessions');
// User image attachments, stored out-of-band so the transcript JSONL stays small.
export const imagesDir = path.join(dataDir, 'images');

fs.mkdirSync(transcriptsDir, { recursive: true });
fs.mkdirSync(agentSessionsDir, { recursive: true });
fs.mkdirSync(imagesDir, { recursive: true });

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
// is redundant. Set DECK_NO_AUTH=1 to skip it. Demo mode also bypasses auth.
export const noAuth =
	DEMO || process.env.DECK_NO_AUTH === '1' || process.env.DECK_NO_AUTH === 'true';

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

// `mode` (e.g. 0o600 for secrets) is applied to the temp file and survives the
// rename. Open with the mode up front so the file never exists world-readable,
// then chmod as well in case the temp path pre-existed with a looser mode
// (open's mode is ignored when the file already exists, and is umask-masked).
export function writeJson(file: string, value: unknown, mode?: number) {
	const target = path.join(dataDir, file);
	const tmp = `${target}.tmp`;
	const data = JSON.stringify(value, null, '\t');
	if (mode === undefined) {
		fs.writeFileSync(tmp, data);
	} else {
		const fd = fs.openSync(tmp, 'w', mode);
		try {
			fs.writeFileSync(fd, data);
		} finally {
			fs.closeSync(fd);
		}
		fs.chmodSync(tmp, mode);
	}
	fs.renameSync(tmp, target);
}
