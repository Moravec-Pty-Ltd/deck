import fs from 'node:fs';
import { error, json } from '@sveltejs/kit';
import type { DeckSession } from '$lib/types';
import { MAX_PATHS_PER_MESSAGE, byteRange } from '$lib/files-core';
import { parseTranscriptRange } from '$lib/transcript-range-core';
import { objectBody, sessionOr404 } from './http';
import { readTranscriptRange } from './transcript';
import { readImage } from './images';
import { fileHeaders, resolveSessionFile, statSessionFiles } from './files';
import { isGitRepo, worktreeDiff, worktreeDiffMeta } from './git';
import { listSessionDir } from './file-browser';

// Read-side per-session handlers, each shared verbatim by a browser route under
// /api/sessions/[id] and its agent API twin under /api/agent/sessions/[id], so
// the two surfaces cannot drift. Auth is enforced globally by hooks.server.ts.

interface SessionEvent {
	params: Partial<Record<string, string>>;
	url: URL;
	request: Request;
}

// An older slice of raw transcript events for back-scroll ({ start, events },
// oldest first). The stream's snapshot only carries the recent tail.
export async function transcriptRangeRoute({ params, url }: SessionEvent): Promise<Response> {
	const session = await sessionOr404(params.id!);
	const { before, limit } = parseTranscriptRange(url.searchParams);
	return json(readTranscriptRange(session.id, before, limit));
}

// A user attachment stored out-of-band (see images.ts). Filenames are
// content-addressed, so the bytes behind one never change: cache hard.
export async function sessionImageRoute({ params }: Pick<SessionEvent, 'params'>): Promise<Response> {
	const session = await sessionOr404(params.id!);
	const img = readImage(session.id, params.file ?? '');
	if (!img) error(404, 'image not found');
	// Copy into a plain Uint8Array; the Node Buffer type isn't structurally a
	// BodyInit, and this overload yields the ArrayBuffer-backed array Response wants.
	return new Response(new Uint8Array(img.data), {
		headers: {
			'content-type': img.media_type,
			'cache-control': 'private, max-age=31536000, immutable'
		}
	});
}

// Files a message mentions. POST { paths } answers which of them exist and can
// be served (with name, size, type); GET ?path= serves one, inline for a
// preview or as an attachment with ?download=1. Both keep to registered
// projects (see files.ts), so an unknown or out-of-bounds path is a 404 rather
// than a hint about the filesystem.
export async function statFilesRoute({ params, request }: SessionEvent): Promise<Response> {
	const session = await sessionOr404(params.id!);
	const body = await objectBody(request);
	const paths = Array.isArray(body.paths) ? body.paths.filter((p): p is string => typeof p === 'string') : [];
	return json({ files: statSessionFiles(session, paths.slice(0, MAX_PATHS_PER_MESSAGE)) });
}

export async function serveFileRoute({ params, url, request }: SessionEvent): Promise<Response> {
	const session = await sessionOr404(params.id!);
	const file = resolveSessionFile(session, url.searchParams.get('path') ?? '');
	if (!file) error(404, 'file not found');
	const headers = fileHeaders(file, url.searchParams.get('download') === '1');
	if (request.headers.get('if-none-match') === headers.etag) return new Response(null, { status: 304, headers });
	// Safari and iOS play a video only from a server that answers byte ranges.
	const range = byteRange(request.headers.get('range'), file.size);
	if (range === 'unsatisfiable') {
		return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${file.size}` } });
	}
	if (range) {
		const slice = new Uint8Array(range.end - range.start + 1);
		const fd = fs.openSync(file.absolute, 'r');
		try {
			fs.readSync(fd, slice, 0, slice.length, range.start);
		} finally {
			fs.closeSync(fd);
		}
		return new Response(slice, {
			status: 206,
			headers: { ...headers, 'content-range': `bytes ${range.start}-${range.end}/${file.size}` }
		});
	}
	return new Response(new Uint8Array(fs.readFileSync(file.absolute)), { headers });
}

// One folder of the session's Files tab: GET ?path=<relative to the session's
// folder>. The files themselves are served by serveFileRoute (same confinement).
export async function sessionDirRoute({ params, url }: Pick<SessionEvent, 'params' | 'url'>): Promise<Response> {
	const session = await sessionOr404(params.id!);
	const result = listSessionDir(session, url.searchParams.get('path') ?? '');
	if (!result.ok) error(result.status, result.message);
	return json(result.listing);
}

// Diff the session's worktree against its base branch, off the session's *stored*
// cwd (never a request-supplied path), so this can't reach outside the directory
// the session already runs in. `metaOnly` returns just the summary for the badge.
async function diffResponse(session: DeckSession, metaOnly: boolean) {
	const cwd = session.cwd;
	const base = session.worktree?.base;
	if (!(await isGitRepo(cwd))) return { git: false };
	if (metaOnly) return { git: true, meta: await worktreeDiffMeta(cwd, base) };
	return { git: true, ...(await worktreeDiff(cwd, base)) };
}

export async function sessionDiffRoute({ params, url }: SessionEvent): Promise<Response> {
	const session = await sessionOr404(params.id!);
	return json(await diffResponse(session, url.searchParams.get('meta') === '1'));
}
