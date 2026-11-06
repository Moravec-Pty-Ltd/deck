// Compose what opens a session's cwd over SSH on the deck host, from whatever
// machine the client is on. A third editor is one more EDITORS entry: the server
// sends the list and clients render it, the Mac after checking the scheme has a
// handler. Kept node-free so the composition is unit-tested without fs/os.

export interface EditorTarget {
	// Absolute cwd of the session (the worktree or plain working dir).
	cwd: string | null | undefined;
	// The host the client reached deck on: over tailnet this is the MagicDNS name
	// or tailnet IP, which is also the SSH target.
	host: string;
	// The deck server's OS user.
	user: string;
	// The SSH target setting, `user@host[:port]`, for when the SSH target differs
	// from the deck host (a different user, port, or address). Blank/absent means
	// use `user@host`.
	override?: string | null;
}

export interface EditorLink {
	name: string;
	scheme: string;
	url: string;
	// The CLI command to paste where a link cannot reach, for editors that have one.
	command: string | null;
}

// `address` is `user@host[:port]/percent/encoded/path`. Zed and VS Code's Remote -
// SSH both accept a port in it and decode the path.
const EDITORS: {
	name: string;
	scheme: string;
	url: (address: string) => string;
	command?: (address: string) => string;
}[] = [
	{
		name: 'Zed',
		scheme: 'zed',
		url: (address) => `zed://ssh/${address}`,
		command: (address) => `zed ssh://${address}`
	},
	{
		name: 'VS Code',
		scheme: 'vscode',
		// Without windowId, a running VS Code may reuse its current window or not open the folder at all.
		url: (address) => `vscode://vscode-remote/ssh-remote+${address}?windowId=_blank`
	}
];

// encodeURIComponent leaves these bare, and a pasted command would hand them to the shell.
const encodeSegment = (segment: string) =>
	encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// Empty when the session has no cwd (nothing to open).
export function composeEditorLinks({ cwd, host, user, override }: EditorTarget): EditorLink[] {
	const path = cwd?.trim();
	if (!path) return [];
	const address = `${override?.trim() || `${user}@${host}`}${path.split('/').map(encodeSegment).join('/')}`;
	return EDITORS.map(({ name, scheme, url, command }) => ({
		name,
		scheme,
		url: url(address),
		command: command?.(address) ?? null
	}));
}
