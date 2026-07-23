// Compose the `zed ssh://…` command that opens a session's cwd on the deck host
// from whatever machine the browser is on. Zed's native SSH remoting only has a
// documented CLI form (https://zed.dev/docs/remote-development), so the affordance
// is copy-to-clipboard of this command, not a launchable link. Kept node-free so
// the composition is unit-tested without fs/os.

export interface ZedCommandParams {
	// Absolute cwd of the session (the worktree or plain working dir).
	cwd: string | undefined | null;
	// Default SSH host — the hostname the browser reached deck on (a tailnet host
	// is typically its own SSH host too).
	host: string;
	// Default SSH user — the deck server process's user.
	user: string;
	// `user@host[:port]` override from DeckSettings, used verbatim when the SSH
	// target differs from the HTTP host/server user.
	override?: string | null;
}

// Returns the command, or null when the session has no cwd (nothing to open).
export function composeZedSshCommand({ cwd, host, user, override }: ZedCommandParams): string | null {
	const path = cwd?.trim();
	if (!path) return null;
	const authority = override?.trim() || `${user}@${host}`;
	return `zed ssh://${authority}${path}`;
}
