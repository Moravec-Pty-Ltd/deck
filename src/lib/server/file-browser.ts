import fs from 'node:fs';
import path from 'node:path';
import type { DeckSession } from '$lib/types';
import { MAX_DIR_ENTRIES, cleanRelPath, sortEntries, type DirEntry, type DirListing } from '$lib/file-browser-core';
import { resolveWithinProjects } from './confine';

// Folder listings for the session Files tab. Browsing starts at the session's
// folder and stays beneath it, and like every other fs sink it is held to the
// registered projects: a session outside them has nothing to browse, and a
// symlink out of bounds is listed but can't be entered or opened.

export type ListResult = { ok: true; listing: DirListing } | { ok: false; status: 403 | 404; message: string };

const NOT_FOUND = { ok: false, status: 404, message: 'folder not found' } as const;

function inside(dir: string, root: string): boolean {
	return dir === root || dir.startsWith(root + path.sep);
}

// The canonical folder `rel` names under the session's folder, or why not.
function resolveDir(session: DeckSession, rel: string): { root: string; rel: string; dir: string } | ListResult {
	const root = resolveWithinProjects(session.cwd);
	if (root === null) return { ok: false, status: 403, message: "this session's folder is outside the registered projects" };
	const clean = cleanRelPath(rel);
	if (clean === null) return NOT_FOUND;
	const dir = resolveWithinProjects(path.join(root, clean));
	return dir !== null && inside(dir, root) ? { root, rel: clean, dir } : NOT_FOUND;
}

function statOrNull(p: string): fs.Stats | null {
	try {
		return fs.statSync(p);
	} catch {
		return null; // dangling or looping symlink, or no permission
	}
}

// Folders and regular files in `dir`, following symlinks; dangling links and
// sockets, fifos and devices are left out. A huge folder is cut to the cap before
// any is looked at, folders (and links, which may be folders) first.
function readEntries(dir: string): { entries: DirEntry[]; truncated: boolean } | null {
	let dirents: fs.Dirent[];
	try {
		dirents = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return null;
	}
	const entries: DirEntry[] = [];
	const rank = (d: fs.Dirent) => (d.isDirectory() || d.isSymbolicLink() ? 0 : 1);
	dirents.sort((a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : 1));
	for (const d of dirents.slice(0, MAX_DIR_ENTRIES)) {
		const stat = statOrNull(path.join(dir, d.name));
		if (!stat || !(stat.isDirectory() || stat.isFile())) continue;
		entries.push({ name: d.name, dir: stat.isDirectory(), size: stat.isFile() ? stat.size : 0, mtimeMs: stat.mtimeMs });
	}
	return { entries, truncated: dirents.length > MAX_DIR_ENTRIES };
}

export function listSessionDir(session: DeckSession, rel: string): ListResult {
	const target = resolveDir(session, rel);
	if ('ok' in target) return target;
	const read = readEntries(target.dir);
	if (read === null) return NOT_FOUND;
	return {
		ok: true,
		listing: {
			path: target.rel,
			root: target.root,
			entries: sortEntries(read.entries),
			truncated: read.truncated
		}
	};
}
