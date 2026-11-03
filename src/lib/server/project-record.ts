import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { error, json } from '@sveltejs/kit';
import type { Project } from '$lib/types';
import { addProject, listProjects, removeProject } from './store';
import { completeDirs, expandTilde } from './fsutil';
import { isPickerAllowed, projectForPath } from './confine';
import { objectBody } from './http';
import { accountExists } from './accounts';
import { buildProjectRecord, homeRegistrationRefusal } from './project-record-core';

// Project registration and config handlers. Register and remove are shared
// verbatim by the browser's /api/projects and its agent API twin, so the two
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
	let project: Project;
	try {
		project = buildProjectRecord(body, dir, existing);
	} catch (e) {
		error(400, e instanceof Error ? e.message : 'invalid project');
	}
	// A stored name that has since been deleted may stay; a newly sent one must exist.
	if (body.account !== undefined && project.account && !accountExists(project.account)) {
		error(400, `no account named ${project.account}`);
	}
	return project;
}

// A new project's stored path: canonical, so a symlink can't later be swapped
// to point the registration somewhere else.
function newProjectDir(dir: string): string {
	if (!isPickerAllowed(dir)) error(403, 'path is outside the allowed directories');
	const real = fs.realpathSync(dir);
	const refusal = homeRegistrationRefusal(real, fs.realpathSync(os.homedir()));
	if (refusal) error(403, refusal);
	return real;
}

// Register a directory, or re-save one already registered. Registering widens
// confinement (confine.ts projectRoots) to the new directory, so it must already
// sit where the path picker may look: $HOME or a registered project. A re-save
// keeps the record's stored path, so it widens nothing.
export async function registerProjectRoute({ request }: Pick<ProjectEvent, 'request'>): Promise<Response> {
	const body = await objectBody(request);
	const dir = resolveDir(body.path);
	let existing = findProject(dir);
	const target = existing?.path ?? newProjectDir(dir);
	existing ??= findProject(target);
	const project = build(body, target, existing);
	addProject(project);
	return json(project, { status: 201 });
}

// A typed start path as the server uses it: trimmed, ~ expanded, no trailing slash.
function startPath(raw: unknown): string {
	return expandTilde(String(raw ?? '').trim()).replace(/(.)\/+$/, '$1');
}

// The deepest part of `dir` that exists.
function existingAncestor(dir: string): string {
	let base = dir;
	while (!fs.existsSync(base)) base = path.dirname(base);
	return base;
}

// Why a missing folder may not be created at `dir`, or its canonical path. The
// rules match registration and the path picker: absolute, no dot segment (so no
// `..` escape and no hidden folder), no NUL, and under $HOME or a project root
// once the existing part's symlinks resolve, never $HOME itself.
function newFolder(dir: string): { real: string } | { refusal: string } {
	if (dir.includes('\0') || !path.isAbsolute(dir)) return { refusal: 'cannot create a folder there: use an absolute path' };
	if (dir.split('/').some((s) => s.startsWith('.'))) return { refusal: 'cannot create a hidden (dot) folder or use ..' };
	const base = existingAncestor(dir);
	if (!isPickerAllowed(base)) return { refusal: 'cannot create a folder outside the allowed directories' };
	if (!fs.statSync(base).isDirectory()) return { refusal: `${base} is not a directory` };
	const real = path.join(fs.realpathSync(base), path.relative(base, dir));
	const refusal = homeRegistrationRefusal(real, fs.realpathSync(os.homedir()));
	return refusal ? { refusal: refusal.replace('register', 'create a folder in') } : { real };
}

// A start request's folder, checked but not yet touched: `create` when it must be
// made, `project` when it is to be registered. Nothing is written until
// commitStartFolder, so a folder or registration refusal leaves neither behind.
export interface StartFolder {
	cwd: string;
	create: boolean;
	project?: Project;
}

function registration(raw: unknown, dir: string, create: boolean): Project {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) error(400, 'registerProject must be an object');
	const { name, group } = raw as Record<string, unknown>;
	const target = create ? dir : newProjectDir(resolveDir(dir));
	if (findProject(target) || findProject(dir)) error(400, 'already a registered project');
	return build({ name, group }, target);
}

export function planStartFolder(rawCwd: unknown, createDir: unknown, registerProject: unknown): StartFolder {
	const given = startPath(rawCwd);
	if (!given) error(400, 'cwd does not exist');
	const create = !fs.existsSync(given);
	if (create && createDir !== true) error(400, 'cwd does not exist');
	const made = create ? newFolder(given) : { real: given };
	if ('refusal' in made) error(400, made.refusal);
	const cwd = made.real;
	if (registerProject === undefined) return { cwd, create };
	return { cwd, create, project: registration(registerProject, cwd, create) };
}

export function commitStartFolder({ cwd, create, project }: StartFolder): void {
	try {
		if (create) fs.mkdirSync(cwd, { recursive: true });
	} catch (e) {
		error(400, `could not create the folder: ${e instanceof Error ? e.message : e}`);
	}
	if (project) addProject(project);
}

// What the start sheet shows for a typed custom path: an existing folder, a new
// one it may create, or why it can't; whether registration would accept it; and
// the registered project it (or a new one's parent) already belongs to. Outside
// the picker's roots it only answers `outside`, so it can't probe the rest of
// the host (a start in an existing folder there still works).
export function folderStateRoute({ url }: Pick<ProjectEvent, 'url'>): Response {
	const dir = startPath(url.searchParams.get('path'));
	if (!dir) error(400, 'path required');
	const base = path.isAbsolute(dir) ? existingAncestor(dir) : null;
	if (base && !isPickerAllowed(base)) return json({ state: 'outside', registrable: false });
	if (base === dir && !isDirectory(dir)) return json({ state: 'refused', reason: 'not a folder', registrable: false });
	const made = base === dir ? { real: fs.realpathSync(dir) } : newFolder(dir);
	if ('refusal' in made) return json({ state: 'refused', reason: made.refusal, registrable: false });
	const registrable = !homeRegistrationRefusal(made.real, fs.realpathSync(os.homedir()));
	const project = projectForPath(base!);
	return json({ state: base === dir ? 'existing' : 'new', registrable, ...(project ? { project } : {}) });
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
