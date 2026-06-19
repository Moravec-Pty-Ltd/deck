import { json, error } from '@sveltejs/kit';
import fs from 'node:fs';
import path from 'node:path';
import type { RequestHandler } from './$types';
import { listProjects, addProject, removeProject } from '$lib/server/store';
import { expandTilde } from '$lib/server/fsutil';

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
		template: String(body.template ?? '').trim() || undefined,
		lastBase: typeof body.lastBase === 'string' ? body.lastBase.trim() || undefined : undefined,
		sources: existing?.sources
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
