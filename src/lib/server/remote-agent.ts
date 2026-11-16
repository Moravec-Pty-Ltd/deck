import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough, Writable } from 'node:stream';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { parseAgentLine, persistsCursor, type AgentCursor, type AgentEntry, type DeckMessage, type DeckToAgent } from '$lib/agent-protocol';
import { agentScript, remoteCommand } from '$lib/remote-core';
import { dataDir } from './config';
import { buildServer } from './mcp';
import type { RemoteConn } from './remote';

// A remote session's claude through the deck agent (issue #411), shaped like
// the ChildProcess claude.ts drives so nothing there changes: stdin takes
// claude's input lines, stdout gives its output lines, and `exit` fires when
// claude on the host ends, not when the SSH connection drops. A drop reconnects
// and the agent replays what was missed, from the last event seen.

const RETRY_MS = [1000, 2000, 5000, 10_000, 15_000];
// Past this without a connection the session errors; the next message
// reattaches, the turn having carried on meanwhile.
const GIVE_UP_MS = 10 * 60_000;

// Where each session's stream got to, so a deck restart neither repeats
// stored events nor skips any.
const cursorDir = path.join(dataDir, 'remote-agent');
const cursorFile = (id: string) => path.join(cursorDir, `${id}.json`);

function readCursor(id: string): AgentCursor | null {
	try {
		const c = JSON.parse(fs.readFileSync(cursorFile(id), 'utf8')) as AgentCursor;
		return typeof c.run === 'string' && typeof c.seq === 'number' ? c : null;
	} catch {
		return null;
	}
}

function writeCursor(id: string, cursor: AgentCursor) {
	fs.mkdirSync(cursorDir, { recursive: true });
	fs.writeFileSync(cursorFile(id), JSON.stringify(cursor));
}

export function removeAgentCursor(id: string) {
	fs.rmSync(cursorFile(id), { force: true });
}

class AgentLink extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly stdin: Writable;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	killed = false;

	private ssh?: ChildProcess;
	private ready = false;
	private everReady = false;
	// Sent but not yet known to be stored on the host, resent after a drop.
	private unacked: { n: number; line: string }[] = [];
	private nextN = 1;
	private readonly linkId = randomUUID().slice(0, 8);
	private cursor: AgentCursor | null;
	private droppedAt = 0;
	private attempt = 0;
	private retry?: ReturnType<typeof setTimeout>;
	private finished = false;
	private mcp: Transport;

	constructor(
		private readonly id: string,
		private readonly conn: RemoteConn,
		start: { path: string; args: string[] }
	) {
		super();
		this.cursor = readCursor(id);
		let partial = '';
		this.stdin = new Writable({
			write: (chunk: Buffer, _enc, done) => {
				const lines = (partial + chunk.toString()).split('\n');
				partial = lines.pop()!;
				for (const line of lines) if (line) this.send({ t: 'input', line });
				done();
			}
		});
		// deck's own MCP tools, reached through the channel instead of HTTP.
		this.mcp = {
			start: async () => {},
			send: async (msg) => this.send({ t: 'mcp', msg }),
			close: async () => this.mcp.onclose?.()
		};
		void buildServer(id).connect(this.mcp);
		this.connect({ t: 'start', ...start });
	}

	kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
		this.killed = true;
		clearTimeout(this.retry);
		if (this.ssh) this.ssh.kill(signal);
		else this.finish(null, signal);
		return true;
	}

	private send(msg: DeckMessage) {
		const n = this.nextN++;
		const line = JSON.stringify({ ...msg, l: this.linkId, n });
		this.unacked.push({ n, line });
		if (this.ready) this.ssh!.stdin!.write(line + '\n');
	}

	private connect(start?: DeckToAgent) {
		const c = this.cursor;
		const args = ['serve', this.id, c?.run ?? '-', String(c?.seq ?? 0), this.linkId, ...(start ? ['start'] : [])];
		const ssh = spawn('ssh', ['-T', ...this.conn.args, remoteCommand(agentScript(args))], { env: this.conn.env, stdio: ['pipe', 'pipe', 'pipe'] });
		this.ssh = ssh;
		ssh.on('error', () => {});
		ssh.stdin.on('error', () => {});
		if (start) ssh.stdin.write(JSON.stringify(start) + '\n');
		createInterface({ input: ssh.stdout }).on('line', (line) => this.receive(line));
		ssh.stderr.on('data', (d: Buffer) => this.stderr.write(d));
		ssh.on('close', (code) => {
			if (this.ssh === ssh) this.dropped(code);
		});
	}

	private receive(line: string) {
		const msg = parseAgentLine(line);
		if (!msg || this.finished) return;
		if (msg.t === 'ready') return this.attached(msg.got);
		if (msg.t === 'ack') return void (this.unacked = this.unacked.filter((m) => m.n > msg.got));
		this.cursor = { run: msg.run, seq: msg.seq };
		if (persistsCursor(msg)) writeCursor(this.id, this.cursor);
		this.deliver(msg);
	}

	// serve holds every message up to `got`; the rest went missing in a drop.
	private attached(got: number) {
		this.ready = this.everReady = true;
		this.attempt = 0;
		this.droppedAt = 0;
		this.unacked = this.unacked.filter((m) => m.n > got);
		for (const m of this.unacked) this.ssh!.stdin!.write(m.line + '\n');
	}

	private deliver(msg: AgentEntry) {
		if (msg.t === 'out') this.stdout.write(msg.line + '\n');
		else if (msg.t === 'err') this.stderr.write(msg.text);
		else if (msg.t === 'mcp') this.mcp.onmessage?.(msg.msg as JSONRPCMessage);
		else this.finish(msg.code, null);
	}

	private dropped(code: number | null) {
		this.ssh = undefined;
		this.ready = false;
		if (this.finished) return;
		if (this.killed) return this.finish(null, 'SIGTERM');
		// Never got going (a refused login, no agent after all): claude.ts reports
		// ssh's reason from stderr.
		if (!this.everReady) return this.finish(code ?? 255, null);
		this.droppedAt ||= Date.now();
		if (Date.now() - this.droppedAt > GIVE_UP_MS) return this.finish(255, null);
		this.retry = setTimeout(() => this.connect(), RETRY_MS[Math.min(this.attempt++, RETRY_MS.length - 1)]);
	}

	private finish(code: number | null, signal: NodeJS.Signals | null) {
		if (this.finished) return;
		this.finished = true;
		this.exitCode = code;
		this.signalCode = signal;
		this.ssh?.kill();
		// Ends the MCP server too, which drops any question still waiting.
		void this.mcp.close();
		// After claude.ts has read the last line, or it would drop it as a dead proc's.
		this.stdout.once('end', () => this.emit('exit', code, signal));
		this.stdout.end();
		this.stderr.end();
	}
}

export function agentClaude(id: string, conn: RemoteConn, start: { path: string; args: string[] }): ChildProcess {
	return new AgentLink(id, conn, start) as unknown as ChildProcess;
}
