// The wire between deck and the deck agent on a remote host (issue #411):
// newline-delimited JSON over one `ssh -T <host> deck-agent serve` per session.
// No node imports, so the agent binary, the server and the web client share it.

// Bump when either side would misread the other's messages.
export const AGENT_PROTOCOL = 1;

// deck -> agent, one per line on serve's stdin. `start` is the first line when
// serve is run with `start`: it starts claude unless one is still running.
// Every other message is numbered (`n`) per link (`l`, the id deck passes to
// serve), so after a drop deck resends the ones the host never stored.
export type DeckMessage = { t: 'input'; line: string } | { t: 'mcp'; msg: unknown };
export type DeckToAgent = { t: 'start'; path: string; args: string[] } | (DeckMessage & { l: string; n: number });

// agent -> deck. Every line the session's claude produced carries the run it
// belongs to and its place in that run, so a reconnect asks for what follows.
// `ready` is serve's own, once it is attached: `got` is the highest message
// number it holds from this link.
export type AgentEvent =
	| { t: 'out'; line: string }
	| { t: 'err'; text: string }
	| { t: 'mcp'; msg: unknown }
	| { t: 'exit'; code: number | null };
export type AgentEntry = AgentCursor & AgentEvent;
export type AgentToDeck = AgentEntry | { t: 'ready'; got: number };

export interface AgentCursor {
	run: string;
	seq: number;
}

export function versionLine(): string {
	return JSON.stringify({ name: 'deck-agent', protocol: AGENT_PROTOCOL });
}

export type AgentDetection = { mode: 'agent' } | { mode: 'bare'; note?: string };

// What `deck-agent --version` printed, or null when it didn't run (no agent):
// the mode to use and, on a version mismatch, why it fell back.
export function detectFromVersion(stdout: string | null): AgentDetection {
	if (stdout === null) return { mode: 'bare' };
	let protocol: unknown;
	try {
		protocol = (JSON.parse(stdout.trim().split('\n').pop() ?? '') as { protocol?: unknown }).protocol;
	} catch {
		protocol = undefined;
	}
	if (protocol === AGENT_PROTOCOL) return { mode: 'agent' };
	const theirs = typeof protocol === 'number' ? `protocol ${protocol}` : 'an unknown protocol';
	return { mode: 'bare', note: `The deck agent on this host speaks ${theirs} and this deck needs protocol ${AGENT_PROTOCOL}, so the session runs over bare SSH. Update the agent to get it back.` };
}

// One line from serve, or null for anything else (noise from a login script).
export function parseAgentLine(line: string): AgentToDeck | null {
	if (!line.startsWith('{')) return null;
	try {
		const msg = JSON.parse(line) as { t?: string; run?: unknown; seq?: unknown; got?: unknown };
		if (msg.t === 'ready') return { t: 'ready', got: typeof msg.got === 'number' ? msg.got : 0 };
		if (typeof msg.run !== 'string' || typeof msg.seq !== 'number') return null;
		return ['out', 'err', 'mcp', 'exit'].includes(msg.t!) ? (msg as AgentEntry) : null;
	} catch {
		return null;
	}
}

// Whether an entry should move the saved cursor. Streaming deltas are only
// shown live, never stored, so replaying one after a deck restart costs
// nothing; skipping them spares a disk write per token.
export function persistsCursor(entry: AgentEntry): boolean {
	return !(entry.t === 'out' && entry.line.startsWith('{"type":"stream_event"'));
}

// The host's machine name from `uname -sm` as a binary suffix, or null when no
// build of the agent runs there.
export function agentBinaryArch(uname: string): 'x64' | 'arm64' | null {
	const [os, machine] = uname.trim().split(/\s+/);
	if (os !== 'Linux') return null;
	if (machine === 'x86_64' || machine === 'amd64') return 'x64';
	if (machine === 'aarch64' || machine === 'arm64') return 'arm64';
	return null;
}
