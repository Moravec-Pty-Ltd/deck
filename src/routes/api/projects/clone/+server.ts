import { json, error } from '@sveltejs/kit';
import fs from 'node:fs';
import path from 'node:path';
import type { RequestHandler } from './$types';
import { listProjects, addProject } from '$lib/server/store';
import { expandTilde } from '$lib/server/fsutil';
import { isPickerAllowed } from '$lib/server/confine';
import { repoNameFromUrl, isCloneUrlSafe } from '$lib/repo-url';
import { cloneRepo } from '$lib/server/git';

const trimField = (v: unknown): string => String(v ?? '').trim();

const asObject = (v: unknown): Record<string, unknown> =>
	v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

function isDir(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

// A repo name that resolves dest to a real child of the parent: non-empty, and
// not `.`/`..` (a slash is already excluded by repoNameFromUrl's tail match).
function isUsableName(name: string | null): name is string {
	return !!name && name !== '.' && name !== '..';
}

// A dest is clonable into when it doesn't exist yet; an existing path blocks
// unless it's an empty directory. A stat error (permissions, a race) is treated
// as blocked rather than risking a clone into an uninspectable path.
function destBlocked(dest: string): boolean {
	try {
		return fs.existsSync(dest) && occupied(dest);
	} catch {
		return true;
	}
}

// An existing path we must not clone over: a symlink final component (git clone
// would write through it, escaping the boundary the parent was checked against),
// or a non-directory / non-empty directory.
function occupied(dest: string): boolean {
	if (fs.lstatSync(dest).isSymbolicLink()) return true;
	return !fs.statSync(dest).isDirectory() || fs.readdirSync(dest).length > 0;
}

// Normalise and shallow-validate the request body (tilde-expanded parent, a
// group that must be a string when present).
function readBody(raw: unknown) {
	const body = asObject(raw);
	if (body.group !== undefined && typeof body.group !== 'string') error(400, 'group must be a string');
	return {
		url: trimField(body.url),
		parent: expandTilde(trimField(body.parent)).replace(/\/+$/, ''),
		name: trimField(body.name),
		group: trimField(body.group) || undefined
	};
}

// The repo name to clone into, or a 4xx: url present, scheme allowed, name usable.
function requireRepoName(url: string): string {
	if (!url) error(400, 'repo url required');
	if (!isCloneUrlSafe(url)) error(400, 'unsupported repo url (use https, ssh, git, or scp-style)');
	const name = repoNameFromUrl(url);
	if (!isUsableName(name)) error(400, 'could not derive a valid repo name from the url');
	return name;
}

// The parent must be an existing dir inside the picker boundary ($HOME or a
// project root); the derived <parent>/<repoName> dest sits under it. The path is
// kept as the user gave it (not canonicalised), matching how POST /api/projects
// stores a registered path; confine.ts canonicalises project roots at check time.
function requireParent(parent: string): void {
	if (!parent || !isDir(parent)) error(400, 'parent is not a directory');
	if (!isPickerAllowed(parent)) error(403, 'parent is outside the allowed directories');
}

// Defensive backstop: dest must be a direct child of parent, in case a repoName
// ever carries a path separator (e.g. a Windows `\`).
function requireChildOfParent(parent: string, dest: string): void {
	if (path.dirname(path.resolve(dest)) !== path.resolve(parent)) {
		error(400, 'could not derive a valid repo name from the url');
	}
}

// The dest must be free: not an occupied path, not already a registered project.
function requireFreeDest(dest: string): void {
	if (destBlocked(dest)) error(409, `destination already exists: ${dest}`);
	if (listProjects().some((p) => p.path === dest)) error(409, 'destination is already a registered project');
}

// Turn a clone failure into a response: git's "already exists" (a dest that filled
// in after requireFreeDest, e.g. a race) is the 409 conflict case, everything else
// a 400 carrying the git stderr.
function cloneFailed(e: unknown): never {
	const msg = e instanceof Error ? e.message : 'git clone failed';
	error(/already exists/i.test(msg) ? 409 : 400, msg);
}

// Clone a remote repo into a subfolder of an existing parent dir, then register
// it. The plain POST /api/projects route still registers an already-present dir.
export const POST: RequestHandler = async ({ request }) => {
	const raw = await request.json().catch(() => error(400, 'invalid JSON body'));
	const { url, parent, name, group } = readBody(raw);
	const repoName = requireRepoName(url);
	requireParent(parent);

	const dest = path.join(parent, repoName);
	requireChildOfParent(parent, dest);
	requireFreeDest(dest);

	try {
		await cloneRepo(url, dest);
	} catch (e) {
		// Nothing is registered on a failed clone; surface the git stderr.
		cloneFailed(e);
	}

	const project = { name: name || repoName, path: dest, group };
	addProject(project);
	return json(project, { status: 201 });
};
