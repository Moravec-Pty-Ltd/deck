import { execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { pinEnv } from './test-env';

// deck's side of the agent channel against the real agent, run from source by
// bun, through a stand-in `ssh` that runs the remote command here.

const hasBun = (() => {
	try {
		execFileSync('bun', ['--version']);
		return true;
	} catch {
		return false;
	}
})();

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-agent-test-'));
const restore = pinEnv({ DECK_DATA: path.join(root, 'data') });
vi.mock('./transcript', () => ({ latestAskToolUseId: async () => 'toolu_1' }));
vi.mock('./agent-feed', () => ({ publishAgentEvent: vi.fn() }));
vi.mock('./apns', () => ({ apnsWidgetsChanged: vi.fn() }));
vi.mock('./push', () => ({ notify: vi.fn() }));
vi.mock('./store', () => ({ getStoredSession: () => undefined }));
const { agentClaude } = await import('./remote-agent');
const { pendingAskId, resolveAsk } = await import('./ask');

const bin = path.join(root, 'bin');
const project = path.join(root, 'project');
const agentHome = path.join(root, 'agent-home');
fs.mkdirSync(bin);
fs.mkdirSync(project);
const script = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
// ssh: everything but the last argument is options; the last is the command.
script('ssh', '#!/bin/sh\nfor a; do last="$a"; done\nexec sh -c "$last"\n');
script('deck-agent', `#!/bin/sh\nexec bun ${path.resolve('src/agent/deck-agent.ts')} "$@"\n`);
// claude: e2e's stand-in for [ask]; anything else ticks out 15 lines, 100 ms
// apart, then a result, so a drop can land mid-turn. Turns queue, as claude's do.
script(
	'claude',
	`#!/bin/sh\nexec node --input-type=module -e '
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
const fake = ${JSON.stringify(path.resolve('e2e/fake-harness/claude'))};
let ask;
let turns = Promise.resolve();
createInterface({ input: process.stdin }).on("line", (line) => {
	if (line.includes("[ask]")) {
		ask ??= spawn(fake, process.argv.slice(1), { stdio: ["pipe", "inherit", "inherit"] });
		return ask.stdin.write(line + "\\n");
	}
	turns = turns.then(async () => {
		for (let i = 1; i <= 15; i++) {
			console.log(JSON.stringify({ type: "assistant", tick: i }));
			await new Promise((r) => setTimeout(r, 100));
		}
		console.log(JSON.stringify({ type: "result", subtype: "success" }));
	});
});' -- "$@"\n`
);

const conn = {
	target: { host: 'box' },
	args: ['box'],
	env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: root, DECK_AGENT_HOME: agentHome }
};

afterAll(() => {
	restore();
	fs.rmSync(root, { recursive: true, force: true });
});

function open(id: string) {
	const link = agentClaude(id, conn as never, { path: project, args: [] });
	const lines: string[] = [];
	let buf = '';
	link.stdout!.on('data', (d: Buffer) => {
		buf += d.toString();
		const parts = buf.split('\n');
		buf = parts.pop()!;
		lines.push(...parts);
	});
	const say = (text: string) => link.stdin!.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
	const drop = () => (link as unknown as { ssh: ChildProcess }).ssh.kill('SIGKILL');
	return { link, lines, say, drop };
}

const stopped = (link: ChildProcess) => new Promise((r) => link.once('exit', r));

describe.skipIf(!hasBun)('AgentLink with the deck agent', () => {
	it('keeps a turn running through a dropped connection and replays the gap in order', async () => {
		const { link, lines, say, drop } = open('s_drop');
		say('count');
		await vi.waitFor(() => expect(lines.length).toBeGreaterThanOrEqual(3), { timeout: 10_000 });
		drop();
		// Sent while the connection is down: delivered after the reconnect.
		say('again');
		await vi.waitFor(() => expect(lines.filter((l) => l.includes('"result"'))).toHaveLength(2), { timeout: 20_000 });
		const ticks = lines.filter((l) => l.includes('tick')).map((l) => JSON.parse(l).tick);
		expect(ticks).toEqual([...Array(15).keys(), ...Array(15).keys()].map((i) => i + 1));
		const exit = stopped(link);
		link.kill();
		execFileSync(path.join(bin, 'deck-agent'), ['stop', 's_drop'], { env: conn.env });
		await exit;
	}, 40_000);

	it("relays deck's ask to deck and the answer back to claude, across a drop", async () => {
		const { link, lines, say, drop } = open('s_ask');
		say('[ask] pick one');
		await vi.waitFor(() => expect(pendingAskId('s_ask')).toBe('toolu_1'), { timeout: 15_000 });
		drop();
		expect(resolveAsk('s_ask', 'Blue')).toBe(true);
		await vi.waitFor(() => expect(lines.some((l) => l.includes('"result"'))).toBe(true), { timeout: 20_000 });
		expect(lines.join('\n')).toContain('Blue');
		// Each message the host stored was acknowledged, so none waits for a resend.
		expect((link as unknown as { unacked: unknown[] }).unacked).toEqual([]);
		const exit = stopped(link);
		link.kill();
		execFileSync(path.join(bin, 'deck-agent'), ['stop', 's_ask'], { env: conn.env });
		await exit;
	}, 40_000);

	it('ends when claude on the host ends', async () => {
		const { link, say } = open('s_stop');
		say('count');
		await new Promise((r) => setTimeout(r, 1500));
		const exit = stopped(link);
		const started = Date.now();
		execFileSync(path.join(bin, 'deck-agent'), ['stop', 's_stop'], { env: conn.env });
		await exit;
		expect(link.killed).toBe(false);
		expect(Date.now() - started).toBeLessThan(4000);
	}, 20_000);
});
