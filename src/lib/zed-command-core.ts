// Compose what opens a session's cwd in Zed over SSH on the deck host, from
// whatever machine the client is on: a `zed://ssh/…` link that launches Zed
// directly, and the `zed ssh://…` CLI command to paste where a link cannot reach.
// Zed decodes percent-encoding in both. Kept node-free so the composition is
// unit-tested without fs/os.

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

// encodeURIComponent leaves these bare, and the pasted command would hand them to the shell.
const encodeSegment = (segment: string) =>
	encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function sshAddress({ cwd, host, user, override }: ZedCommandParams): string | null {
	const path = cwd?.trim();
	if (!path) return null;
	const authority = override?.trim() || `${user}@${host}`;
	return `${authority}${path.split('/').map(encodeSegment).join('/')}`;
}

// Returns the command, or null when the session has no cwd (nothing to open).
export function composeZedSshCommand(params: ZedCommandParams): string | null {
	const address = sshAddress(params);
	return address && `zed ssh://${address}`;
}

// Returns the link, or null when the session has no cwd (nothing to open).
export function composeZedUrl(params: ZedCommandParams): string | null {
	const address = sshAddress(params);
	return address && `zed://ssh/${address}`;
}
