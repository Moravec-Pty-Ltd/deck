import { json, error } from '@sveltejs/kit';
import fs from 'node:fs';
import path from 'node:path';
import type { RequestHandler } from './$types';
import type { DevConfig } from '$lib/types';
import { listProjects, addProject, removeProject } from '$lib/server/store';
import { expandTilde } from '$lib/server/fsutil';
import { parseDevConfig } from '$lib/server/devservers-core';

// Validate the dev-server config when present; carry the existing one across an
// edit that doesn't touch it (the form sends the whole object when it does). A
// bad config is a 400, not a 500.
function resolveDev(body: { dev?: unknown }, existing: DevConfig | undefined): DevConfig | undefined {
	if (body.dev === undefined) return existing;
	try {
		return parseDevConfig(body.dev);
	} catch (e) {
		error(400, e instanceof Error ? e.message : 'invalid dev config');
	}
}

// Resolve the optional group: trim a provided value (blank clears it), or carry
// the existing project's group across a save that omits it (e.g. the dev-config
// form), mirroring how sources/dev are preserved.
function resolveGroup(body: { group?: unknown }, existing: string | undefined): string | undefined {
	if (body.group === undefined) return existing;
	// Reject a malformed group rather than silently clearing the stored one.
	if (typeof body.group !== 'string') error(400, 'group must be a string');
	return body.group.trim() || undefined;
}

export const GET: RequestHandler = async () => {
	return json(listProjects());
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const dir = expandTilde(String(body.path ?? '').trim()).replace(/\/+$/, '');
	if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
		error(400, 'path is not a directory');
	}
	// Sources are managed through /api/projects/sources, never sent in this body,
	// so carry the existing project's sources across a name/template/base edit.
	const existing = listProjects().find((p) => p.path === dir);
	const project = {
		name: String(body.name ?? '').trim() || path.basename(dir),
		path: dir,
		group: resolveGroup(body, existing?.group),
		template: String(body.template ?? '').trim() || undefined,
		lastBase: typeof body.lastBase === 'string' ? body.lastBase.trim() || undefined : undefined,
		sources: existing?.sources,
		dev: resolveDev(body, existing?.dev)
	};
	addProject(project);
	return json(project, { status: 201 });
};

export const DELETE: RequestHandler = async ({ url }) => {
	const dir = url.searchParams.get('path');
	if (!dir) error(400, 'path required');
	removeProject(dir);
	return json({ ok: true });
};
