import fs from 'node:fs';
import { error, json } from '@sveltejs/kit';
import type { Project } from '$lib/types';
import { addProject, listProjects, removeProject } from './store';
import { completeDirs, expandTilde } from './fsutil';
import { isPickerAllowed } from './confine';
import { objectBody } from './http';
import { buildProjectRecord } from './project-record-core';

// Project registration and config handlers, each shared verbatim by a browser
// route under /api/projects (or /api/fs) and its agent API twin, so the two
// surfaces cannot drift. Auth is enforced globally by hooks.server.ts.

interface ProjectEvent {
	request: Request;
	url: URL;
}

function isDirectory(dir: string): boolean {
	return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
}

function resolveDir(raw: unknown): string {
	const dir = expandTilde(String(raw ?? '').trim()).replace(/\/+$/, '');
	if (!dir || !isDirectory(dir)) error(400, 'path is not a directory');
	return dir;
}

function findProject(path: string): Project | undefined {
	return listProjects().find((p) => p.path === path);
}

function build(body: Record<string, unknown>, dir: string, existing?: Project): Project {
	try {
		return buildProjectRecord(body, dir, existing);
	} catch (e) {
		error(400, e instanceof Error ? e.message : 'invalid project');
	}
}

// Register a directory, or re-save one already registered. Registering widens
// confinement (confine.ts projectRoots) to the new directory, so it must already
// sit where the path picker may look: $HOME or a registered project.
export async function registerProjectRoute({ request }: Pick<ProjectEvent, 'request'>): Promise<Response> {
	const body = await objectBody(request);
	const dir = resolveDir(body.path);
	if (!isPickerAllowed(dir)) error(403, 'path is outside the allowed directories');
	const project = build(body, dir, findProject(dir));
	addProject(project);
	return json(project, { status: 201 });
}

export function removeProjectRoute({ url }: Pick<ProjectEvent, 'url'>): Response {
	const dir = url.searchParams.get('path');
	if (!dir) error(400, 'path required');
	removeProject(dir);
	return json({ ok: true });
}

// One project's full stored record, or every one when no path is given.
export function projectConfigRoute({ url }: Pick<ProjectEvent, 'url'>): Response {
	const path = url.searchParams.get('path');
	if (path === null) return json(listProjects());
	const project = findProject(path);
	if (!project) error(404, 'project not found');
	return json(project);
}

// Edit a registered project's config. Omitted fields keep their stored value;
// the path itself is the key and cannot change.
export async function patchProjectConfigRoute({ request }: Pick<ProjectEvent, 'request'>): Promise<Response> {
	const body = await objectBody(request);
	if (typeof body.path !== 'string' || !body.path.trim()) error(400, 'path required');
	const existing = findProject(body.path.trim());
	if (!existing) error(404, 'project not found');
	const project = build(body, existing.path, existing);
	addProject(project);
	return json(project);
}

// Directory completions for the path picker, confined to $HOME and the
// registered projects (see completeDirs).
export function completeDirsRoute({ url }: Pick<ProjectEvent, 'url'>): Response {
	return json(completeDirs(url.searchParams.get('q') ?? ''));
}
