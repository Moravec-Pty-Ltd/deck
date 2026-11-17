import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { abandoned, end, eventWriter, follower, highestSent, livePid, numbered, pump, routeInput, serveMcp } from './agent-core';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-core-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

it('follows a file that appears later and grows in pieces', () => {
	const file = path.join(dir, 'follow.ndjson');
	const lines: string[] = [];
	const poll = follower(file, (l) => lines.push(l));
	expect(poll()).toBe(false);
	fs.writeFileSync(file, 'one\ntw');
	expect(poll()).toBe(true);
	expect(lines).toEqual(['one']);
	fs.appendFileSync(file, 'o\n\nthree\n');
	poll();
	expect(lines).toEqual(['one', 'two', 'three']);
	expect(poll()).toBe(false);
});

it('keeps a character split across reads whole', () => {
	const file = path.join(dir, 'wide.ndjson');
	const text = 'é'.repeat(40_000);
	fs.writeFileSync(file, `${text}\nend\n`);
	const lines: string[] = [];
	follower(file, (l) => lines.push(l))();
	expect(lines).toEqual([text, 'end']);
});

it("counts only this link's numbered messages", () => {
	const file = path.join(dir, 'in.ndjson');
	fs.writeFileSync(file, ['{"t":"input","line":"a","l":"me","n":1}', '{"t":"input","line":"b","l":"old","n":9}', '{"t":"mcp","msg":{},"l":"me","n":2}', 'junk'].join('\n') + '\n');
	expect(numbered('{"t":"start","path":"/x","args":[]}', 'me')).toBe(0);
	expect(highestSent(file, 'me')).toBe(2);
	expect(highestSent(file, 'other')).toBe(0);
	expect(highestSent(path.join(dir, 'missing'), 'me')).toBe(0);
});

it('routes input to claude and replies to the MCP endpoint', () => {
	const to = { input: vi.fn(), mcp: vi.fn() };
	const seen = new Map<string, number>();
	routeInput('{"t":"input","line":"hi","l":"x","n":1}', seen, to);
	routeInput('{"t":"mcp","msg":{"id":1},"l":"x","n":2}', seen, to);
	// The same line again, from a second serve: taken once.
	routeInput('{"t":"input","line":"hi","l":"x","n":1}', seen, to);
	routeInput('{"t":"input","line":"new link","l":"y","n":1}', seen, to);
	routeInput('nonsense', seen, to);
	routeInput('{"t":"input","l":"x","n":3}', seen, to);
	expect(to.input.mock.calls).toEqual([['hi'], ['new link']]);
	expect(to.mcp).toHaveBeenCalledWith({ id: 1 });
});

describe('eventWriter', () => {
	const entry = (seq: number, t = 'out') => JSON.stringify({ run: 'r', seq, t, ...(t === 'exit' ? { code: 0 } : { line: '{}' }) });

	it('passes on what follows the cursor and quits after the exit', () => {
		const written: string[] = [];
		const quit = vi.fn();
		const out = eventWriter(2, (l) => written.push(l), quit);
		[1, 2, 3].forEach((s) => out.forward(entry(s)));
		out.forward(entry(4, 'exit'));
		out.forward(entry(5));
		expect(written.map((l) => JSON.parse(l).seq)).toEqual([3, 4]);
		expect(quit).toHaveBeenCalledOnce();
	});

	it("drops a finished run's exit and MCP requests while passing on its leftovers", () => {
		const written: string[] = [];
		const out = eventWriter(0, (l) => written.push(l), vi.fn());
		out.leftovers = true;
		out.forward(entry(1));
		out.forward(JSON.stringify({ run: 'r', seq: 2, t: 'mcp', msg: { method: 'tools/call' } }));
		out.forward(entry(3, 'exit'));
		expect(written.map((l) => JSON.parse(l).seq)).toEqual([1]);
		expect(out.ended).toBe(false);
	});

	it('numbers a silent death after the cursor', () => {
		const written: string[] = [];
		eventWriter(40, (l) => written.push(l), vi.fn()).died('r');
		expect(JSON.parse(written[0]).seq).toBe(41);
	});

	it('says the run ended when the runner died silently, once', () => {
		const written: string[] = [];
		const out = eventWriter(0, (l) => written.push(l), vi.fn());
		out.forward(entry(1));
		out.died('r');
		out.died('r');
		expect(written.map((l) => JSON.parse(l))).toEqual([JSON.parse(entry(1)), { run: 'r', seq: 2, t: 'exit', code: null }]);
	});
});

describe('pump', () => {
	it('reads until the exit, or says the run ended once the runner is gone and drained', async () => {
		const written: string[] = [];
		const out = eventWriter(0, (l) => written.push(l), vi.fn());
		const reads = [true, false, false, true, false, false];
		const alive = [true, false, false];
		await pump(() => reads.shift() ?? false, () => alive.shift() ?? false, out, 'r', 1);
		expect(reads).toEqual([]);
		expect(written).toEqual([JSON.stringify({ run: 'r', seq: 1, t: 'exit', code: null })]);
	});
});

describe('livePid and end', () => {
	it('ends a live process that ignores TERM, and only one that is alive', async () => {
		const child = spawn('/bin/sh', ['-c', 'trap "" TERM; while :; do sleep 0.05; done']);
		const file = path.join(dir, 'p.pid');
		fs.writeFileSync(file, String(child.pid));
		await new Promise((r) => setTimeout(r, 100));
		expect(livePid(file, 'sh')).toBe(child.pid);
		const gone = new Promise((r) => child.once('exit', (_c, sig) => r(sig)));
		await end(child.pid!, 300);
		expect(await gone).toBe('SIGKILL');
		expect(livePid(file, 'sh')).toBeNull();
		expect(livePid(path.join(dir, 'none.pid'), 'sh')).toBeNull();
		await end(null);
	});
});

describe('serveMcp', () => {
	it('serves /mcp only, with the parsed body, and fails a bad request cleanly', async () => {
		const handleRequest = vi.fn(async (_req: http.IncomingMessage, res: http.ServerResponse, body?: unknown) => {
			res.end(JSON.stringify(body ?? null));
		});
		const server = http.createServer((req, res) => void serveMcp({ handleRequest }, req, res));
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
		const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
		try {
			expect((await fetch(`${base}/other`)).status).toBe(404);
			const ok = await fetch(`${base}/mcp`, { method: 'POST', body: '{"id":1}' });
			expect(await ok.json()).toEqual({ id: 1 });
			expect((await fetch(`${base}/mcp`, { method: 'POST', body: '{nope' })).status).toBe(500);
		} finally {
			server.close();
		}
	});
});

it('counts a claude abandoned only when idle and unvisited past the limit', () => {
	expect(abandoned(0, 0, 10_000, 100)).toBe(false);
	expect(abandoned(1000, 0, 1050, 100)).toBe(false);
	expect(abandoned(1000, 0, 1200, 100)).toBe(true);
	expect(abandoned(1000, 1150, 1200, 100)).toBe(false);
});
