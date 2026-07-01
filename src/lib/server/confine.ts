import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listProjects } from './store';

// Confinement for request-supplied filesystem/git paths. The auth token (or the
// tailnet under DECK_NO_AUTH) is not a fine-grained boundary, so endpoints that
// reach fs/git sinks must keep their target within the registered project set
// rather than anywhere the server user can read.

// Canonical, symlink-free absolute form, or null if the path doesn't resolve.
// Symlinks are followed so a link inside an allowed root can't point out of it,
// and a path that doesn't exist is treated as out of bounds.
function canonical(p: string): string | null {
	try {
		return fs.realpathSync(p);
	} catch {
		return null;
	}
}

// True if `child` is `root` itself or nested beneath it (both canonical).
function within(child: string, root: string): boolean {
	if (child === root) return true;
	return child.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

function isUnder(dir: string, roots: string[]): boolean {
	const real = canonical(dir);
	return real !== null && roots.some((root) => within(real, root));
}

// Canonical roots a confined path must fall under. A registered project path is
// resolved as-is (the user registered that location, symlink or not). Its
// sibling `<name>-worktrees` dir, where deck's worktrees land (see
// createWorktree), is anchored to the *resolved* project path and matched
// literally, so a symlink planted at the worktrees root can't redirect
// confinement to the symlink's target.
function projectRoots(): string[] {
	const roots: string[] = [];
	for (const p of listProjects()) {
		const proj = canonical(p.path);
		if (proj === null) continue;
		roots.push(proj, `${proj}-worktrees`);
	}
	return roots;
}

// Canonical (symlink-free) form of `dir` if it is a registered project or one of
// its worktrees, else null. Callers that go on to run git/fs against the path
// must use the returned canonical form: a symlink whose realpath is in bounds
// passes the check, but operating on the original path would let the symlink
// redirect a derived sink (e.g. createWorktree's <repo>-worktrees dir) out of
// bounds.
export function resolveWithinProjects(dir: string): string | null {
	const real = canonical(dir);
	if (real === null) return null;
	return projectRoots().some((root) => within(real, root)) ? real : null;
}

// Is `dir` a registered project or one of its worktrees? Confines the `repo`
// target of the git endpoints to the registered project set.
export function isWithinProjects(dir: string): boolean {
	return resolveWithinProjects(dir) !== null;
}

// Is `dir` somewhere the path picker may enumerate? The picker also needs $HOME,
// since a new project's directory is chosen before it is registered.
export function isPickerAllowed(dir: string): boolean {
	const home = canonical(os.homedir());
	return isUnder(dir, home === null ? projectRoots() : [home, ...projectRoots()]);
}

// Resolve a user-supplied relative path under `root`, rejecting absolute paths
// and any `..` escape. Returns the joined absolute path, or null if it would
// escape. Purely lexical (no fs), so it validates paths that don't exist yet:
// dev-config copyFromMain destinations and setup-step cwds (see devservers.ts).
export function confineRelative(root: string, rel: string): string | null {
	if (rel.includes('\0')) return null; // NUL would truncate the path at the fs syscall
	if (path.isAbsolute(rel)) return null;
	const base = path.resolve(root);
	const joined = path.resolve(base, rel);
	if (joined === base) return joined;
	return joined.startsWith(base + path.sep) ? joined : null;
}
