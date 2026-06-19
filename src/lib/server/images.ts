import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { imagesDir } from './config';

// User attachments are stored out-of-band as files under the data dir and
// referenced by filename in the transcript, instead of inlined as base64 in the
// deck.user event. Inline base64 inflated the JSONL by ~33% per image and that
// bloat was paid again on every full-transcript re-parse (snapshot/back-scroll).

export interface StoredImage {
	file: string;
	media_type: string;
}

// Covers exactly the media types the send endpoint admits (png/jpe?g/gif/webp),
// so a persisted image is always readable back through FILE_RE below.
const EXT: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/jpg': 'jpg',
	'image/gif': 'gif',
	'image/webp': 'webp'
};
const FILE_RE = /^[a-f0-9]{16}\.(png|jpg|gif|webp)$/;

function sessionDir(id: string): string {
	return path.join(imagesDir, id.replace(/[^a-zA-Z0-9_-]/g, '_'));
}

// Canonical media type for a stored extension, so the transcript ref and the
// served content type always agree (.jpg covers both image/jpeg and image/jpg).
function mediaTypeForExt(ext: string): string {
	return ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
}

// Content-addressed by sha256 so re-sending the same image is a no-op write and
// the filename alone is enough to read it back.
export function persistImage(id: string, media_type: string, data: string): StoredImage {
	const ext = EXT[media_type];
	if (!ext) throw new Error(`unsupported image media type: ${media_type}`);
	const buf = Buffer.from(data, 'base64');
	const file = `${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)}.${ext}`;
	const dir = sessionDir(id);
	fs.mkdirSync(dir, { recursive: true });
	const dest = path.join(dir, file);
	// The bytes are content-addressed, so an existing file already holds them.
	// 'wx' fails rather than rewriting; swallow EEXIST instead of a check-then-act
	// stat that two concurrent sends could both pass.
	try {
		fs.writeFileSync(dest, buf, { flag: 'wx' });
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
	}
	return { file, media_type: mediaTypeForExt(ext) };
}

// Reads a stored attachment. The filename is validated against the
// content-addressed shape so a path can't traverse out of the session dir.
export function readImage(id: string, file: string): { data: Buffer; media_type: string } | null {
	if (!FILE_RE.test(file)) return null;
	try {
		const data = fs.readFileSync(path.join(sessionDir(id), file));
		return { data, media_type: mediaTypeForExt(file.slice(file.lastIndexOf('.') + 1)) };
	} catch {
		return null;
	}
}
