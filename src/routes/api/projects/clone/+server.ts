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
	return fs.existsSync(p) && fs.statSync(p).isDirectory();
}

// A repo name that resolves dest to a real child of the parent: non-empty, and
// not `.`/`..` (a slash is already excluded by repoNameFromUrl's tail match).
function isUsableName(name: string | null): name is string {
	return !!name && name !== '.' && name !== '..';
}

// A dest is clonable into when it doesn't exist yet; an existing path blocks
// unless it's an empty directory.
function destBlocked(dest: string): boolean {
	if (!fs.existsSync(dest)) return false;
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
	if (!isCloneUrlSafe(url)) error(400, 'unsupported repo url (use an https, ssh, git, or scp-style url)');
	const name = repoNameFromUrl(url);
	if (!isUsableName(name)) error(400, 'could not derive a valid repo name from the url');
	return name;
}

// The parent must be an existing dir inside the picker boundary ($HOME or a
// project root); the derived <parent>/<repoName> dest sits under it.
function requireParent(parent: string): void {
	if (!parent || !isDir(parent)) error(400, 'parent is not a directory');
	if (!isPickerAllowed(parent)) error(403, 'parent is outside the allowed directories');
}

// The dest must be free: not an occupied path, not already a registered project.
function requireFreeDest(dest: string): void {
	if (destBlocked(dest)) error(409, `destination already exists: ${dest}`);
	if (listProjects().some((p) => p.path === dest)) error(409, 'destination is already a registered project');
}

// Clone a remote repo into a subfolder of an existing parent dir, then register
// it. The plain POST /api/projects route still registers an already-present dir.
export const POST: RequestHandler = async ({ request }) => {
	const raw = await request.json().catch(() => error(400, 'invalid JSON body'));
	const { url, parent, name, group } = readBody(raw);
	const repoName = requireRepoName(url);
	requireParent(parent);

	const dest = path.join(parent, repoName);
	requireFreeDest(dest);

	try {
		await cloneRepo(url, dest);
	} catch (e) {
		// Surface the git stderr; nothing is registered on a failed clone.
		error(400, e instanceof Error ? e.message : 'git clone failed');
	}

	const project = { name: name || repoName, path: dest, group };
	addProject(project);
	return json(project, { status: 201 });
};
