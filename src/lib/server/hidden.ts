import { readJson, writeJson } from './config';
import { getStoredSession, listProjects } from './store';
import { hiddenProjectPaths, withHidden } from '$lib/hidden-core';
import { deriveGroup } from '$lib/time';

const HIDDEN_FILE = 'hidden-sessions.json';

// The ids of the sessions the user has hidden, in their own file rather than on
// the session record: an adhoc tmux terminal has no record to write to (see
// sessions.ts adhocView), and without this it could never be hidden. A hidden
// *project* does live on its record, since a project always has one.

function stored(): string[] {
	return readJson<string[]>(HIDDEN_FILE, []);
}

export function hiddenSessionIds(): Set<string> {
	return new Set(stored());
}

// Writes only on a real change, so deleting a session that was never hidden
// doesn't rewrite the file.
export function setSessionHidden(id: string, hidden: boolean): void {
	const ids = stored();
	const next = withHidden(ids, id, hidden);
	if (next.length !== ids.length) writeJson(HIDDEN_FILE, next);
}

// Whether one session is in the Hidden section, by its own id or its project's.
// Answered from the store rather than the session list so it stays cheap enough
// for the notification gate (see push.ts): hiding a session says you don't want
// to hear from it either.
export function isSessionHidden(id: string): boolean {
	if (hiddenSessionIds().has(id)) return true;
	const cwd = getStoredSession(id)?.cwd;
	if (!cwd) return false;
	const projects = listProjects();
	return hiddenProjectPaths(projects).has(deriveGroup(cwd, projects).key);
}

// Renaming an adhoc terminal moves its id (see session-title.ts), so carry the
// hide across or the terminal comes back visible under its new name.
export function moveHidden(from: string, to: string): void {
	const ids = stored();
	if (!ids.includes(from)) return;
	writeJson(HIDDEN_FILE, withHidden(withHidden(ids, from, false), to, true));
}
