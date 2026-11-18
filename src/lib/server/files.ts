import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DeckSession } from '$lib/types';
import { basename, isImagePath, mimeFor, scriptable, type FileInfo } from '$lib/files-core';
import { MAX_EDIT_BYTES, checkEdit } from '$lib/file-edit-core';
import { resolveWithinProjects } from './confine';

// Files a session's messages mention, served back to the clients for previews
// and downloads. A mention is resolved the way the agent meant it (home and
// file URLs expanded, relative paths taken from the session's cwd) and then
// held to the same boundary as every other fs sink: only a regular file inside
// a registered project or its worktrees is served, anything else is simply
// absent.

// Larger than any screenshot or report; a mention of a huge artefact is left
// alone rather than read whole into memory.
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

export interface ServedFile extends FileInfo {
	absolute: string;
	mtimeMs: number;
}

function expand(session: DeckSession, mention: string): string {
	let p = mention.startsWith('file://') ? mention.slice('file://'.length) : mention;
	if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
	return path.isAbsolute(p) ? p : path.resolve(session.cwd, p);
}

// The file behind a mention, or null when it is missing, not a regular file,
// too large, or outside the registered projects.
export function resolveSessionFile(session: DeckSession, mention: string): ServedFile | null {
	if (!mention || mention.includes('\0')) return null;
	const absolute = resolveWithinProjects(expand(session, mention));
	if (absolute === null) return null;
	let stat: fs.Stats;
	try {
		stat = fs.statSync(absolute);
	} catch {
		return null;
	}
	if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
	return {
		path: mention,
		name: basename(absolute),
		size: stat.size,
		mime: mimeFor(absolute),
		image: isImagePath(absolute),
		absolute,
		mtimeMs: stat.mtimeMs
	};
}

// Response headers for serving a file: inline for a preview or as an
// attachment, revalidated by an ETag from size and mtime since a file can
// change under the same path. A scriptable document (SVG, HTML) is sandboxed
// so opened as a page it cannot run under deck's origin and cookie; <img> is
// unaffected and other types stay plain so the browser's PDF viewer works.
// Text is labelled UTF-8: without a charset a browser opening the file falls
// back to a legacy single-byte encoding and garbles every accented letter.
function contentType(mime: string): string {
	const textual = mime.startsWith('text/') || mime === 'application/json' || mime.endsWith('xml');
	return textual ? `${mime}; charset=utf-8` : mime;
}

export function fileHeaders(file: ServedFile, download: boolean): Record<string, string> {
	const headers: Record<string, string> = {
		'content-type': contentType(file.mime),
		'cache-control': 'private, no-cache',
		'x-content-type-options': 'nosniff',
		'accept-ranges': 'bytes',
		etag: `"${file.size}-${Math.floor(file.mtimeMs)}"`,
		'content-disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(file.name)}`
	};
	if (scriptable(file.mime)) headers['content-security-policy'] = "default-src 'none'; sandbox";
	return headers;
}

export function statSessionFiles(session: DeckSession, mentions: string[]): FileInfo[] {
	const files: FileInfo[] = [];
	// A remote session's mentions name files on its host; the Files tab reads those.
	if (session.remote) return files;
	for (const mention of mentions) {
		const file = resolveSessionFile(session, mention);
		if (file) files.push({ path: file.path, name: file.name, size: file.size, mime: file.mime, image: file.image });
	}
	return files;
}

export function sha256Hex(data: Buffer | string): string {
	return crypto.createHash('sha256').update(data).digest('hex');
}

export type SaveResult = { ok: true; sha256: string; size: number } | { ok: false; status: number; message: string };

// Replace an existing text file's content. Resolved and confined exactly like a
// read; refused when the file changed since `expected` (the sha256 the editor
// loaded). Written to a temp file beside the original, fsynced and renamed over
// it, with the original's mode kept. Contents are never logged.
export function saveSessionFile(session: DeckSession, mention: string, text: string, expected: string): SaveResult {
	const file = resolveSessionFile(session, mention);
	if (!file) return { ok: false, status: 404, message: 'file not found' };
	const newBytes = Buffer.byteLength(text);
	if (file.size > MAX_EDIT_BYTES || newBytes > MAX_EDIT_BYTES) {
		return { ok: false, status: 413, message: 'file too large to edit (limit 1 MB)' };
	}
	const current = fs.readFileSync(file.absolute);
	const check = checkEdit({
		name: file.name,
		currentSize: current.length,
		currentHead: current.subarray(0, 8192).toString('utf8'),
		currentHash: sha256Hex(current),
		newBytes,
		expected
	});
	if (!check.ok) return check;
	const mode = fs.statSync(file.absolute).mode & 0o7777;
	const tmp = path.join(path.dirname(file.absolute), `.${file.name}.deck-${process.pid}-${Date.now()}.tmp`);
	let fd: number | null = null;
	try {
		fd = fs.openSync(tmp, 'wx', 0o600);
		fs.writeSync(fd, text);
		fs.fchmodSync(fd, mode);
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = null;
		fs.renameSync(tmp, file.absolute);
	} catch {
		if (fd !== null) fs.closeSync(fd);
		fs.rmSync(tmp, { force: true });
		return { ok: false, status: 500, message: 'could not write the file' };
	}
	return { ok: true, sha256: sha256Hex(text), size: newBytes };
}
