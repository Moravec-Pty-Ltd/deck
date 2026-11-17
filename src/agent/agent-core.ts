import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import type http from 'node:http';
import type { AgentEntry, DeckToAgent } from '../lib/agent-protocol';

// The deck agent's moving parts (issue #411), apart from its entry point
// (deck-agent.ts) so they can be tested in-process. node: APIs only, which bun
// compiles into the binary.

const KILL_GRACE_MS = 3000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function parse<T>(line: string): T | null {
	try {
		return JSON.parse(line) as T;
	} catch {
		return null;
	}
}

export function readText(file: string): string | null {
	try {
		return fs.readFileSync(file, 'utf8').trim();
	} catch {
		return null;
	}
}

function signal(pid: number, sig: NodeJS.Signals | 0): boolean {
	try {
		process.kill(pid, sig);
		return true;
	} catch {
		return false;
	}
}

// The pid in a pid file while that process is still alive and still ours: its
// command line names `marker`, so a reused pid is left alone. Without /proc
// (macOS) liveness alone decides.
export function livePid(file: string, marker: string): number | null {
	const pid = Number(readText(file));
	if (!(pid > 0) || !signal(pid, 0)) return null;
	const cmdline = readText(`/proc/${pid}/cmdline`);
	return cmdline === null || cmdline.includes(marker) ? pid : null;
}

// TERM, then KILL past the grace period: the escalation a local stop uses.
export async function end(pid: number | null, graceMs = KILL_GRACE_MS) {
	if (!pid || !signal(pid, 'SIGTERM')) return;
	for (let waited = 0; waited < graceMs && signal(pid, 0); waited += 50) await sleep(50);
	if (signal(pid, 0)) signal(pid, 'SIGKILL');
}

function openForRead(file: string): number | null {
	try {
		return fs.openSync(file, 'r');
	} catch {
		return null;
	}
}

// Follow an append-only file from the start, line by line. The file may not
// exist yet. Each call reads what is new and returns whether there was any.
// Decoded across chunk edges, so a character split between reads survives.
export function follower(file: string, onLine: (line: string) => void) {
	let fd: number | null = null;
	let partial = '';
	const decoder = new StringDecoder('utf8');
	const chunk = Buffer.alloc(64 * 1024);
	return () => {
		fd ??= openForRead(file);
		if (fd === null) return false;
		let got = false;
		for (let n; (n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0; ) {
			got = true;
			const lines = (partial + decoder.write(chunk.subarray(0, n))).split('\n');
			partial = lines.pop()!;
			lines.filter(Boolean).forEach(onLine);
		}
		return got;
	};
}

// A deck message's number when it came from `link`, else 0.
export function numbered(line: string, link: string): number {
	const msg = parse<{ l?: string; n?: unknown }>(line);
	return msg?.l === link && typeof msg.n === 'number' ? msg.n : 0;
}

// The highest message number from `link` the file already holds.
export function highestSent(file: string, link: string): number {
	let got = 0;
	follower(file, (line) => (got = Math.max(got, numbered(line, link))))();
	return got;
}

// Hand one line of in.ndjson to the runner's claude or its MCP endpoint, once:
// `seen` holds the highest number taken per link, as a serve still running
// from before a drop can append a line the new one also resends.
export function routeInput(line: string, seen: Map<string, number>, to: { input: (line: string) => void; mcp: (msg: unknown) => void }) {
	const msg = parse<DeckToAgent>(line);
	if (msg?.t === 'start' || typeof msg?.n !== 'number' || msg.n <= (seen.get(msg.l) ?? 0)) return;
	seen.set(msg.l, msg.n);
	if (msg.t === 'input' && typeof msg.line === 'string') to.input(msg.line);
	else if (msg.t === 'mcp') to.mcp(msg.msg);
}

// Whether an idle claude (idle since `idleSince`, 0 while a turn runs) has
// gone `limitMs` without a serve looking in (`heartbeat`, ms).
export function abandoned(idleSince: number, heartbeat: number, now: number, limitMs: number): boolean {
	return idleSince > 0 && now - Math.max(idleSince, heartbeat) > limitMs;
}

// Passes the session's events after `skip` on to deck, and quits once claude's
// exit has gone out.
export function eventWriter(skip: number, write: (line: string) => void, quit: () => void) {
	const out = {
		skip,
		// From the cursor, so a synthesised exit never sends it backwards.
		lastSeq: skip,
		ended: false,
		// Passing on a finished run's leftovers: its end isn't news any more, and
		// its MCP requests came from a claude that is gone.
		leftovers: false,
		wants(entry: AgentEntry) {
			return !out.ended && entry.seq > out.skip && !(out.leftovers && (entry.t === 'exit' || entry.t === 'mcp'));
		},
		forward(line: string) {
			const entry = parse<AgentEntry>(line);
			if (!entry || !out.wants(entry)) return;
			out.lastSeq = entry.seq;
			write(line);
			if (entry.t === 'exit') out.end();
		},
		// The runner is gone without a word (killed outright, or never ran).
		died(run: string | null) {
			if (out.ended) return;
			write(JSON.stringify({ run: run ?? '', seq: out.lastSeq + 1, t: 'exit', code: null }));
			out.end();
		},
		end() {
			out.ended = true;
			quit();
		}
	};
	return out;
}

// Read new events until claude's exit has gone out. `poll` reads what is new
// and says whether there was any; `alive` whether the runner still is.
export async function pump(poll: () => boolean, alive: () => boolean, out: ReturnType<typeof eventWriter>, run: string | null, idleMs = 50) {
	while (!out.ended) {
		if (poll()) continue;
		if (alive()) await sleep(idleMs);
		// One last read for what it wrote on the way out.
		else if (!poll()) out.died(run);
	}
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const c of req) chunks.push(c as Buffer);
	return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
}

type McpHandler = { handleRequest(req: http.IncomingMessage, res: http.ServerResponse, body?: unknown): Promise<void> };

// One request to the runner's loopback MCP endpoint.
export async function serveMcp(mcp: McpHandler, req: http.IncomingMessage, res: http.ServerResponse) {
	if (!req.url?.startsWith('/mcp')) return void res.writeHead(404).end();
	try {
		await mcp.handleRequest(req, res, req.method === 'POST' ? await readJson(req) : undefined);
	} catch {
		if (!res.headersSent) res.writeHead(500);
		res.end();
	}
}
