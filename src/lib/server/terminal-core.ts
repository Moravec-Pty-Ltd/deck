// Input and query parsing for driving a shell session's tmux pane, shared by
// the browser's /snapshot + /send and the agent API's /terminal. Keys are a
// named allowlist of tmux key names, so a client can press Enter or ctrl-c but
// can't smuggle tmux's own syntax through the key field.

const SNAPSHOT_LINES_DEFAULT = 500;
export const SNAPSHOT_LINES_MAX = 5000;
export const TEXT_MAX_BYTES = 4096;
const TAG_MAX = 64;

const NAMED_KEYS = [
	'Enter',
	'Escape',
	'Tab',
	'BTab',
	'BSpace',
	'DC',
	'Space',
	'Up',
	'Down',
	'Left',
	'Right',
	'Home',
	'End',
	'PPage',
	'NPage'
];
const CTRL_KEYS = 'abcdefghijklmnopqrstuvwxyz'.split('').map((c) => `C-${c}`);
const TERMINAL_KEYS: ReadonlySet<string> = new Set([...NAMED_KEYS, ...CTRL_KEYS]);

export type TerminalInput = { key: string } | { text: string; submit: boolean };

export interface SnapshotQuery {
	lines: number;
	h: string | null;
}

// { key } presses one allowlisted key; { text, submit? } types literal text and,
// unless submit is false, presses Enter after it. Empty text with submit is a
// bare Enter, which the web terminal's send button relies on.
export function parseTerminalInput(body: Record<string, unknown>): TerminalInput | { error: string } {
	if (body.key !== undefined) {
		if (typeof body.key === 'string' && TERMINAL_KEYS.has(body.key)) return { key: body.key };
		return { error: 'unknown key' };
	}
	if (typeof body.text !== 'string') return { error: 'text or key is required' };
	if (new TextEncoder().encode(body.text).length > TEXT_MAX_BYTES) {
		return { error: `text is over ${TEXT_MAX_BYTES} bytes` };
	}
	const submit = body.submit !== false;
	// tmux types a newline as Enter, so it would run the line submit:false holds back.
	if (!submit && /[\r\n]/.test(body.text)) {
		return { error: 'text with submit false must not contain a newline: it would press Enter' };
	}
	return { text: body.text, submit };
}

// ?lines= falls back to a default page and is held to SNAPSHOT_LINES_MAX; ?h= is
// the tag of the snapshot the client already has.
export function parseSnapshotQuery(params: URLSearchParams): SnapshotQuery {
	const n = Math.floor(Number(params.get('lines') ?? ''));
	const lines = Number.isFinite(n) && n > 0 ? Math.min(n, SNAPSHOT_LINES_MAX) : SNAPSHOT_LINES_DEFAULT;
	const h = params.get('h')?.slice(0, TAG_MAX) || null;
	return { lines, h };
}
