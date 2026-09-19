import fs from 'node:fs';
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { objectBody, sessionOr404 } from '$lib/server/http';
import { fileHeaders, resolveSessionFile, statSessionFiles } from '$lib/server/files';
import { MAX_PATHS_PER_MESSAGE } from '$lib/files-core';

// Files a message mentions. POST { paths } answers which of them exist and can
// be served (with name, size, type); GET ?path= serves one, inline for a
// preview or as an attachment with ?download=1. Both keep to registered
// projects (see server/files.ts), so an unknown or out-of-bounds path is a 404
// rather than a hint about the filesystem.
export const POST: RequestHandler = async ({ params, request }) => {
	const session = await sessionOr404(params.id);
	const body = await objectBody(request);
	const paths = Array.isArray(body.paths) ? body.paths.filter((p): p is string => typeof p === 'string') : [];
	return json({ files: statSessionFiles(session, paths.slice(0, MAX_PATHS_PER_MESSAGE)) });
};

export const GET: RequestHandler = async ({ params, url, request }) => {
	const session = await sessionOr404(params.id);
	const file = resolveSessionFile(session, url.searchParams.get('path') ?? '');
	if (!file) error(404, 'file not found');
	const headers = fileHeaders(file, url.searchParams.get('download') === '1');
	if (request.headers.get('if-none-match') === headers.etag) return new Response(null, { status: 304, headers });
	return new Response(new Uint8Array(fs.readFileSync(file.absolute)), { headers });
};
