import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { uploadsDir } from './config';
import { safeUploadName } from '$lib/upload-core';

// A file shared with a session from outside deck, written under the data dir
// rather than into the worktree: sharing a PDF should not dirty a repo or show
// up in a diff. The agent reads it by the absolute path this returns.
//
// Images have their own path (base64 inline on the send endpoint, see
// images.ts); this is for everything the model cannot be handed directly.

function sessionDir(id: string): string {
	return path.join(uploadsDir, id.replace(/[^a-zA-Z0-9_-]/g, '_'));
}

export interface StoredUpload {
	// Absolute, because the only useful thing to do with it is read it.
	path: string;
	name: string;
	bytes: number;
}

// Content-addressed prefix, readable suffix: two shares of the same file land
// on one path, and two different files called `report.pdf` don't collide.
export function persistUpload(id: string, name: string, data: string): StoredUpload {
	const buf = Buffer.from(data, 'base64');
	const safe = safeUploadName(name);
	const digest = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);
	const dir = sessionDir(id);
	fs.mkdirSync(dir, { recursive: true });
	const dest = path.join(dir, `${digest}-${safe}`);
	// 0600: a share can carry anything, so don't widen it past the user.
	fs.writeFileSync(dest, buf, { mode: 0o600 });
	return { path: dest, name: safe, bytes: buf.length };
}

// Drop a session's shared files when the session goes, so the data dir doesn't
// collect uploads for sessions that no longer exist.
export function forgetUploads(id: string): void {
	fs.rmSync(sessionDir(id), { recursive: true, force: true });
}
