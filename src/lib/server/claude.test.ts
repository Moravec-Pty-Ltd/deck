import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnAgent = vi.hoisted(() => vi.fn());
vi.mock('./agents/spawn', () => ({ spawnAgent }));
vi.mock('./transcript-writer', () => ({
	appendLine: vi.fn(() => Promise.resolve()),
	whenDrained: () => Promise.resolve()
}));
vi.mock('./store', () => ({
	getStoredSession: (id: string) => ({ id, kind: 'claude', title: 't', cwd: '/tmp' }),
	setSessionStatus: vi.fn(),
	updateSession: vi.fn()
}));
vi.mock('./mcp', () => ({ ensureMcp: () => Promise.resolve(), mcpUrl: () => 'http://mcp' }));
vi.mock('./ask', () => ({ rejectAsk: vi.fn() }));
vi.mock('./push', () => ({ notify: vi.fn() }));
vi.mock('./transcript', () => ({ transcriptPath: (id: string) => `/t/${id}`, transcriptCostSummary: vi.fn() }));
vi.mock('./agent-feed', () => ({ publishAgentEvent: vi.fn() }));
vi.mock('./agents/env', () => ({ agentEnv: () => ({}) }));
vi.mock('./model-profiles', () => ({ findModelProfile: () => undefined, resolveModelArg: () => undefined }));

const { appendLine } = await import('./transcript-writer');
const { setSessionStatus } = await import('./store');
const { rejectAsk } = await import('./ask');
const claude = await import('./claude');

function written(): Record<string, unknown>[] {
	return vi.mocked(appendLine).mock.calls.map((c) => JSON.parse(c[1] as string));
}

function fakeChild() {
	const child = Object.assign(new EventEmitter(), {
		stdout: new EventEmitter(),
		stderr: new EventEmitter(),
		stdin: { write: vi.fn() },
		exitCode: null,
		killed: false,
		kill: vi.fn()
	});
	return child;
}

let seq = 0;
beforeEach(() => {
	vi.clearAllMocks();
	seq++;
});

describe('sendMessage when claude cannot start', () => {
	it('errors the session and rejects its pending ask, then tries afresh next time', async () => {
		const id = `c_fail_${seq}`;
		spawnAgent.mockRejectedValueOnce(new Error("could not start claude: it was not found on the server's PATH"));
		await claude.sendMessage(id, 'hi');

		expect(written().map((e) => e.type)).toEqual(['deck.user', 'deck.error']);
		expect(written()[1].text).toContain('could not start claude');
		expect(vi.mocked(setSessionStatus).mock.calls.at(-1)?.[1]).toBe('error');
		expect(rejectAsk).toHaveBeenCalledWith(id, 'process failed to start');
		expect(claude.hasProcess(id)).toBe(false);

		const child = fakeChild();
		spawnAgent.mockResolvedValueOnce(child);
		await claude.sendMessage(id, 'again');
		expect(spawnAgent).toHaveBeenCalledTimes(2);
		expect(child.stdin.write).toHaveBeenCalledOnce();
	});

	it('shares one start between messages sent while it is starting', async () => {
		const id = `c_share_${seq}`;
		const child = fakeChild();
		let up!: (c: unknown) => void;
		spawnAgent.mockReturnValueOnce(new Promise((r) => (up = r)));
		const first = claude.sendMessage(id, 'one');
		const second = claude.sendMessage(id, 'two');
		await vi.waitFor(() => expect(spawnAgent).toHaveBeenCalled());
		up(child);
		await Promise.all([first, second]);

		expect(spawnAgent).toHaveBeenCalledOnce();
		expect(child.stdin.write).toHaveBeenCalledTimes(2);
	});

	it('drops a start that was stopped midway, as when the session is deleted', async () => {
		const id = `c_stop_${seq}`;
		const stale = fakeChild();
		let up!: (c: unknown) => void;
		spawnAgent.mockReturnValueOnce(new Promise((r) => (up = r)));
		const sent = claude.sendMessage(id, 'one');
		await vi.waitFor(() => expect(spawnAgent).toHaveBeenCalled());
		claude.stopProcess(id);
		up(stale);
		await sent;

		expect(stale.kill).toHaveBeenCalledWith('SIGTERM');
		expect(stale.stdin.write).not.toHaveBeenCalled();
		expect(spawnAgent).toHaveBeenCalledOnce();
		expect(claude.hasProcess(id)).toBe(false);
	});
});
