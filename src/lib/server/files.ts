import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DeckSession } from '$lib/types';
import { basename, isImagePath, mimeFor, scriptable, type FileInfo } from '$lib/files-core';
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
export function fileHeaders(file: ServedFile, download: boolean): Record<string, string> {
	const headers: Record<string, string> = {
		'content-type': file.mime,
		'cache-control': 'private, no-cache',
		'x-content-type-options': 'nosniff',
		etag: `"${file.size}-${Math.floor(file.mtimeMs)}"`,
		'content-disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(file.name)}`
	};
	if (scriptable(file.mime)) headers['content-security-policy'] = "default-src 'none'; sandbox";
	return headers;
}

export function statSessionFiles(session: DeckSession, mentions: string[]): FileInfo[] {
	const files: FileInfo[] = [];
	for (const mention of mentions) {
		const file = resolveSessionFile(session, mention);
		if (file) files.push({ path: file.path, name: file.name, size: file.size, mime: file.mime, image: file.image });
	}
	return files;
}
