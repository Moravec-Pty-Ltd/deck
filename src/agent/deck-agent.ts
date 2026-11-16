// deck-agent: the optional helper deck runs on a remote host (issue #411),
// compiled to one binary with `pnpm build:agent` (bun), so the host needs no
// runtime. It never listens on the network: deck talks to it over the stdin and
// stdout of `ssh -T <host> deck-agent serve`.
//
//   deck-agent --version            protocol check
//   deck-agent serve <id> <run> <seq> <link> [start]
//                                   the channel: replays the session's events
//                                   after <run>/<seq>, then streams new ones
//   deck-agent run <id>             (internal) owns one claude, detached
//   deck-agent stop <id>            ends the session's claude
//   deck-agent forget <id>          ends it and removes the session's files
//
// A runner outlives the SSH connection: it writes everything claude prints to
// ~/.deck-agent/<id>/events.ndjson and reads what deck sends from in.ndjson, so
// any later serve can pick the session up where the last one dropped.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { versionLine, type AgentEvent, type DeckToAgent } from '../lib/agent-protocol';
import { NO_CLAUDE_MARK, NO_PATH_MARK } from '../lib/remote-core';
import { abandoned, end, eventWriter, follower, highestSent, livePid, numbered, parse, pump, readText, routeInput, serveMcp } from './agent-core';

function lastHeartbeat(file: string): number {
	try {
		return fs.statSync(file).mtimeMs;
	} catch {
		return 0;
	}
}

const POLL_MS = 50;
// An idle claude no serve has looked in on for this long ends: deck is gone or
// the session was deleted while it couldn't reach the host. While deck is
// attached, its own idle teardown decides.
const ABANDONED_MS = 60 * 60_000;
const HEARTBEAT_MS = 30_000;
const home = process.env.DECK_AGENT_HOME || path.join(os.homedir(), '.deck-agent');

function fail(message: string): never {
	process.stderr.write(`deck-agent: ${message}\n`);
	process.exit(2);
}

function sessionFiles(id: string | undefined) {
	if (!id || !/^[a-z0-9_-]+$/.test(id)) fail(`bad session id: ${id}`);
	const dir = path.join(home, id);
	return {
		dir,
		run: path.join(dir, 'run'),
		start: path.join(dir, 'start.json'),
		events: path.join(dir, 'events.ndjson'),
		input: path.join(dir, 'in.ndjson'),
		runnerPid: path.join(dir, 'runner.pid'),
		claudePid: path.join(dir, 'claude.pid'),
		// Touched by an attached serve.
		heartbeat: path.join(dir, 'heartbeat')
	};
}
type Files = ReturnType<typeof sessionFiles>;
type Start = { path: string; args: string[] };

// --- run: one claude, detached from any SSH connection ------------------------

async function runner(id: string) {
	const f = sessionFiles(id);
	const run = readText(f.run)!;
	const start = JSON.parse(fs.readFileSync(f.start, 'utf8')) as Start;
	fs.writeFileSync(f.runnerPid, String(process.pid));
	const out = fs.openSync(f.events, 'a');
	let seq = 0;
	const emit = (e: AgentEvent) => fs.writeSync(out, JSON.stringify({ run, seq: ++seq, ...e }) + '\n');
	const finish = (code: number | null) => {
		emit({ t: 'exit', code });
		fs.rmSync(f.claudePid, { force: true });
		fs.rmSync(f.runnerPid, { force: true });
		process.exit(0);
	};

	if (!fs.existsSync(start.path)) {
		emit({ t: 'err', text: `${NO_PATH_MARK}: ${start.path}\n` });
		finish(1);
	}

	// deck's tools for this claude: an MCP endpoint on loopback whose messages
	// are relayed to deck through the event log and answered through in.ndjson,
	// so a question asked while deck is away waits for it to come back.
	const mcp = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
	mcp.onmessage = (msg) => emit({ t: 'mcp', msg });
	await mcp.start();
	const server = http.createServer((req, res) => void serveMcp(mcp, req, res));
	const port = await new Promise<number>((resolve) =>
		server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
	);

	const mcpConfig = JSON.stringify({ mcpServers: { deck: { type: 'http', url: `http://127.0.0.1:${port}/mcp` } } });
	const child = spawn('claude', [...start.args, '--mcp-config', mcpConfig], { cwd: start.path, stdio: ['pipe', 'pipe', 'pipe'] });
	child.on('error', (e: NodeJS.ErrnoException) => {
		emit({ t: 'err', text: `${e.code === 'ENOENT' ? NO_CLAUDE_MARK : e.message}\n` });
		finish(127);
	});
	if (child.pid) fs.writeFileSync(f.claudePid, String(child.pid));
	child.stdin.on('error', () => {});
	// From the spawn: a claude whose first message never comes is idle too.
	let idleSince = Date.now();
	createInterface({ input: child.stdout }).on('line', (line) => {
		emit({ t: 'out', line });
		if (line.startsWith('{"type":"result"')) idleSince = Date.now();
	});
	child.stderr.on('data', (d: Buffer) => emit({ t: 'err', text: d.toString() }));
	child.on('close', (code) => finish(code));
	// From stop, which ends claude first. Its exit is recorded on close, unless
	// something it left behind still holds its stdout: then now.
	process.on('SIGTERM', () => {
		if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
		else finish(child.exitCode);
	});

	const seen = new Map<string, number>();
	const poll = follower(f.input, (line) =>
		routeInput(line, seen, {
			input: (text) => {
				// A control request (an interrupt on an idle claude) starts no turn.
				if (text.startsWith('{"type":"user"')) idleSince = 0;
				child.stdin.write(text + '\n');
			},
			// A reply to a request claude already gave up on has nowhere to go.
			mcp: (msg) => void mcp.send(msg as Parameters<typeof mcp.send>[0]).catch(() => {})
		})
	);
	let ending = false;
	setInterval(() => {
		poll();
		if (ending || !abandoned(idleSince, lastHeartbeat(f.heartbeat), Date.now(), ABANDONED_MS)) return;
		ending = true;
		void end(child.pid ?? null);
	}, POLL_MS);
}

// --- serve: the channel to deck -----------------------------------------------

function startRun(id: string, f: Files, start: Start): string {
	const run = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
	for (const file of [f.events, f.input, f.claudePid]) fs.rmSync(file, { force: true });
	fs.writeFileSync(f.start, JSON.stringify({ path: start.path, args: start.args }));
	fs.writeFileSync(f.run, run);
	// The compiled binary is its own entry; run from source, bun needs the script.
	const self = process.argv[1]?.includes('$bunfs') ? [] : [process.argv[1]];
	const child = spawn(process.execPath, [...self, 'run', id], { detached: true, stdio: 'ignore', cwd: home });
	child.unref();
	fs.writeFileSync(f.runnerPid, String(child.pid));
	return run;
}

const write = (line: string) => process.stdout.write(line + '\n');
// Once stdout has drained: a pipe write may still be queued.
const quit = () => process.stdout.write('', () => process.exit(0));

// deck's lines on stdin, one at a time. deck hanging up ends serve; the runner
// carries on without it.
function stdinLines(): () => Promise<string> {
	const queue: string[] = [];
	let wake: (() => void) | undefined;
	const rl = createInterface({ input: process.stdin });
	rl.on('line', (line) => {
		queue.push(line);
		wake?.();
	});
	rl.on('close', () => process.exit(0));
	return async () => {
		while (!queue.length) await new Promise<void>((r) => (wake = r));
		return queue.shift()!;
	};
}

type Writer = ReturnType<typeof eventWriter>;

// Keep a running claude; otherwise pass on what the last run left unseen and
// start a new one. Returns the run that now holds the session.
function takeOver(id: string, f: Files, run: string | null, line: string, out: Writer): string | null {
	const msg = parse<DeckToAgent>(line);
	if (msg?.t !== 'start') fail('expected a start message');
	if (livePid(f.runnerPid, id)) return run;
	out.leftovers = true;
	follower(f.events, out.forward)();
	out.leftovers = false;
	out.skip = out.lastSeq = 0;
	return startRun(id, f, msg);
}

async function relayInput(next: () => Promise<string>, file: string, link: string, got: number) {
	for (;;) {
		const line = await next();
		const n = numbered(line, link);
		if (n <= got) continue;
		got = n;
		// forget may have removed the folder under us.
		try {
			fs.appendFileSync(file, line + '\n');
		} catch {
			process.exit(0);
		}
	}
}

async function serve(id: string, cursorRun: string, cursorSeq: number, link: string, start: boolean) {
	const f = sessionFiles(id);
	fs.mkdirSync(f.dir, { recursive: true, mode: 0o700 });
	const next = stdinLines();
	let run = readText(f.run);
	const out = eventWriter(cursorRun === run ? cursorSeq : 0, write, quit);
	if (start) run = takeOver(id, f, run, await next(), out);
	const got = highestSent(f.input, link);
	write(JSON.stringify({ t: 'ready', got }));
	void relayInput(next, f.input, link, got);
	const beat = () => {
		try {
			fs.writeFileSync(f.heartbeat, '');
		} catch {
			process.exit(0);
		}
	};
	beat();
	setInterval(beat, HEARTBEAT_MS);
	await pump(follower(f.events, out.forward), () => !!livePid(f.runnerPid, id), out, run, POLL_MS);
}

async function stop(id: string) {
	const f = sessionFiles(id);
	await end(livePid(f.claudePid, 'claude'));
	// The runner leaves once claude has; this only matters if it never started one.
	await end(livePid(f.runnerPid, id));
}

async function forget(id: string) {
	await stop(id);
	fs.rmSync(sessionFiles(id).dir, { recursive: true, force: true });
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === '--version') console.log(versionLine());
else if (cmd === 'serve') void serve(rest[0], rest[1], Number(rest[2]) || 0, rest[3], rest[4] === 'start');
else if (cmd === 'run') void runner(rest[0]);
else if (cmd === 'stop') void stop(rest[0]);
else if (cmd === 'forget') void forget(rest[0]);
else fail('usage: deck-agent --version | serve <id> <run> <seq> <link> [start] | stop <id> | forget <id>');
