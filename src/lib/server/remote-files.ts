import type { DeckSession } from '$lib/types';
import { basename, isImagePath, mimeFor } from '$lib/files-core';
import { MAX_DIR_ENTRIES, cleanRelPath, sortEntries, type DirEntry } from '$lib/file-browser-core';
import { remoteJoin, shellQuote } from '$lib/remote-core';
import { runRemote, runRemoteRaw, sessionConnection } from './remote';
import type { ListResult } from './file-browser';
import { MAX_FILE_BYTES, type ServedFile } from './files';

// The Files tab for a remote session (issue #410), read-only over ssh with
// plain POSIX tools. The folder the host resolves (`pwd -P`, so symlinks are
// followed) must stay inside the session's folder, like the local rule.

const NOT_FOUND = { ok: false, status: 404, message: 'folder not found' } as const;

// Enter `dir`, then fail (exit 4) unless its real path sits under the root's.
function enterWithin(root: string, dir: string): string {
	return [
		`cd ${shellQuote(root)} 2>/dev/null || exit 4`,
		'r=$(pwd -P)',
		`cd ${shellQuote(dir)} 2>/dev/null || exit 4`,
		'd=$(pwd -P)',
		'case "$d/" in "$r"/*) ;; *) exit 4;; esac'
	].join('\n');
}

function listScript(root: string, dir: string): string {
	return [
		enterWithin(root, dir),
		`printf '%s\\0' "$r"`,
		'n=0',
		'for f in .* *; do',
		'  case "$f" in .|..) continue;; esac',
		`  [ $n -gt ${MAX_DIR_ENTRIES} ] && break`,
		'  if [ -d "$f" ]; then printf \'d\\t0\\t0\\t%s\\0\' "$f"',
		'  elif [ -f "$f" ]; then printf \'f\\t%s\\t%s\\t%s\\0\' "$(wc -c < "$f" | tr -d \' \')" "$(date -r "$f" +%s 2>/dev/null || echo 0)" "$f"',
		'  else continue; fi',
		'  n=$((n+1))',
		'done'
	].join('\n');
}

function parseEntries(out: string): { real: string; entries: DirEntry[] } {
	const [real, ...records] = out.split('\0');
	const entries: DirEntry[] = [];
	for (const rec of records) {
		const m = /^([df])\t(\d+)\t(\d+)\t(.+)$/s.exec(rec);
		if (m) entries.push({ name: m[4], dir: m[1] === 'd', size: Number(m[2]), mtimeMs: Number(m[3]) * 1000 });
	}
	return { real, entries };
}

export async function listRemoteDir(session: DeckSession, rel: string): Promise<ListResult> {
	const root = session.remote!.path;
	const clean = cleanRelPath(rel);
	const dir = clean === null ? null : remoteJoin(root, clean);
	if (clean === null || dir === null) return NOT_FOUND;
	let out: string;
	try {
		out = await runRemote(sessionConnection(session), listScript(root, dir));
	} catch (e) {
		if ((e as { code?: number }).code === 4) return NOT_FOUND;
		return { ok: false, status: 404, message: e instanceof Error ? e.message : 'folder not found' };
	}
	const { entries } = parseEntries(out);
	const sorted = sortEntries(entries);
	return {
		ok: true,
		listing: { path: clean, root, entries: sorted.slice(0, MAX_DIR_ENTRIES), truncated: sorted.length > MAX_DIR_ENTRIES }
	};
}

// The absolute path a request names, inside the session's folder, or null.
function remotePath(root: string, mention: string): string | null {
	if (!mention || /[\0\n\r]/.test(mention)) return null;
	if (!mention.startsWith('/')) return remoteJoin(root, mention);
	if (mention !== root && !mention.startsWith(root.replace(/\/+$/, '') + '/')) return null;
	return remoteJoin(root, mention.slice(root.length).replace(/^\/+/, ''));
}

// A file in the session's folder on the host, read whole, or null. A symlinked
// file is refused rather than followed out of the folder.
export async function readRemoteFile(session: DeckSession, mention: string): Promise<{ file: ServedFile; data: Buffer } | null> {
	const root = session.remote!.path;
	const absolute = remotePath(root, mention);
	if (!absolute || absolute === root) return null;
	const slash = absolute.lastIndexOf('/');
	const dir = absolute.slice(0, slash) || '/';
	const name = absolute.slice(slash + 1);
	const script = [
		enterWithin(root, dir),
		`b=${shellQuote(name)}`,
		'[ -f "$b" ] && [ ! -L "$b" ] || exit 4',
		`[ "$(wc -c < "$b" | tr -d ' ')" -le ${MAX_FILE_BYTES} ] || exit 5`,
		'cat "$b"'
	].join('\n');
	let data: Buffer;
	try {
		data = await runRemoteRaw(sessionConnection(session), script, { maxBuffer: MAX_FILE_BYTES + 1024 });
	} catch {
		return null;
	}
	const file: ServedFile = {
		path: mention,
		name: basename(absolute),
		size: data.length,
		mime: mimeFor(absolute),
		image: isImagePath(absolute),
		absolute,
		mtimeMs: 0
	};
	return { file, data };
}
