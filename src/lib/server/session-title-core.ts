// The storage-shape half of renaming a session, node-free so it unit tests
// without a store or a tmux server. The title rules themselves are shared with
// the browser and live in $lib/session-title; the fs/tmux wiring is in
// session-title.ts.
//
// Two shapes sit behind the one endpoint: a stored session keeps its title in
// sessions.json and its id never moves, while an adhoc tmux terminal has no
// deck record at all, so its title *is* the tmux session name and renaming it
// renames the tmux session.

// A tmux session name deck can still reach. tmux splits a `-t` target on `:`
// into session and window before the exact-match `=` applies, so a name
// carrying one is unreachable by name for good: deck could never kill it or
// send to it again. `.` and spaces are fine.
export function tmuxSessionName(title: string): string {
	return title.replace(/:/g, '-');
}

// An unregistered tmux session surfaces as `t_<tmux name>` (see adhocView), so
// its id moves when it is renamed and the caller has to follow.
const ADHOC_PREFIX = 't_';

export function adhocId(tmuxName: string): string {
	return ADHOC_PREFIX + tmuxName;
}

export function isAdhocId(id: string): boolean {
	return id.startsWith(ADHOC_PREFIX);
}

export function adhocTmuxName(id: string): string {
	return id.slice(ADHOC_PREFIX.length);
}
