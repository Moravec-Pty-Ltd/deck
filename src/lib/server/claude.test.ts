import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnAgent = vi.hoisted(() => vi.fn());
const subagentIds = vi.hoisted(() => vi.fn((): string[] => []));
vi.mock('./agents/spawn', () => ({ spawnAgent }));
vi.mock('./transcript-writer', () => ({
	appendLine: vi.fn(() => Promise.resolve()),
	whenDrained: () => Promise.resolve()
}));
vi.mock('./store', () => ({
	getStoredSession: (id: string) => ({ id, kind: 'claude', title: 't', cwd: '/tmp', status: 'idle' }),
	setSessionStatus: vi.fn(),
	updateSession: vi.fn()
}));
vi.mock('./mcp', () => ({ ensureMcp: () => Promise.resolve(), mcpUrl: () => 'http://mcp' }));
vi.mock('./ask', () => ({ rejectAsk: vi.fn() }));
vi.mock('./push', () => ({ notify: vi.fn() }));
vi.mock('./transcript', () => ({
	transcriptPath: (id: string) => `/t/${id}`,
	transcriptCostSummary: vi.fn(),
	runningSubagentIds: subagentIds
}));
vi.mock('./agent-feed', () => ({ publishAgentEvent: vi.fn() }));
vi.mock('./agents/env', () => ({ agentEnv: () => ({}) }));
vi.mock('./model-profiles', () => ({ findModelProfile: () => undefined, resolveModelArg: () => undefined }));

const { appendLine } = await import('./transcript-writer');
const { setSessionStatus } = await import('./store');
const { rejectAsk } = await import('./ask');
const { notify } = await import('./push');
const { publishAgentEvent } = await import('./agent-feed');
const claude = await import('./claude');

function written(): Record<string, unknown>[] {
	return vi.mocked(appendLine).mock.calls.map((c) => JSON.parse(c[1] as string));
}

function fakeChild() {
	const child = Object.assign(new EventEmitter(), {
		stdout: new EventEmitter(),
		stderr: new EventEmitter(),
		stdin: { write: vi.fn(), on: vi.fn() },
		exitCode: null,
		signalCode: null,
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

// A session whose first turn has ended, its process still up.
async function afterTurn(id: string) {
	const child = fakeChild();
	spawnAgent.mockResolvedValueOnce(child);
	await claude.sendMessage(id, 'one');
	child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', subtype: 'success' }) + '\n'));
	return child;
}

describe('stopping a turn', () => {
	it('stops a turn while claude is still starting, so the message never runs', async () => {
		const id = `c_early_${seq}`;
		const child = fakeChild();
		let up!: (c: unknown) => void;
		spawnAgent.mockReturnValueOnce(new Promise((r) => (up = r)));
		const sent = claude.sendMessage(id, 'one');
		await vi.waitFor(() => expect(spawnAgent).toHaveBeenCalled());

		expect(claude.interrupt(id)).toBe(true);
		up(child);
		await sent;

		expect(child.kill).toHaveBeenCalledWith('SIGTERM');
		expect(child.stdin.write).not.toHaveBeenCalled();
		expect(written().map((e) => e.type)).toEqual(['deck.user', 'result']);
		expect(vi.mocked(setSessionStatus).mock.calls.at(-1)?.[1]).toBe('idle');
	});

	it('interrupts a running turn, and reports an idle process as nothing to stop', async () => {
		const id = `c_turn_${seq}`;
		const child = fakeChild();
		spawnAgent.mockResolvedValueOnce(child);
		await claude.sendMessage(id, 'one');

		expect(claude.interrupt(id)).toBe(true);
		expect(JSON.parse(child.stdin.write.mock.calls.at(-1)![0]).request.subtype).toBe('interrupt');
		child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', subtype: 'error_during_execution' }) + '\n'));
		expect(claude.interrupt(id)).toBe(false);
		expect(claude.interrupt('c_none')).toBe(false);
	});

	it('stops the subagents of a session whose turn has ended', async () => {
		const id = `c_subs_${seq}`;
		const child = await afterTurn(id);
		subagentIds.mockReturnValue(['t1', 't2']);
		try {
			expect(claude.interrupt(id)).toBe(true);
			const sent = child.stdin.write.mock.calls.slice(-2).map((c) => JSON.parse(c[0]).request);
			expect(sent).toEqual([
				{ subtype: 'stop_task', task_id: 't1' },
				{ subtype: 'stop_task', task_id: 't2' }
			]);
		} finally {
			subagentIds.mockReturnValue([]);
		}
	});

	it('force stop ends the turn, and SIGKILLs a process that ignores SIGTERM', async () => {
		vi.useFakeTimers();
		try {
			const id = `c_force_${seq}`;
			const child = fakeChild();
			spawnAgent.mockResolvedValueOnce(child);
			await claude.sendMessage(id, 'one');

			expect(claude.forceStop(id)).toBe(true);
			expect(child.kill).toHaveBeenCalledWith('SIGTERM');
			expect(claude.hasProcess(id)).toBe(false);
			expect(written().at(-1)?.type).toBe('result');
			expect(vi.mocked(setSessionStatus).mock.calls.at(-1)?.[1]).toBe('idle');

			vi.advanceTimersByTime(3000);
			expect(child.kill).toHaveBeenLastCalledWith('SIGKILL');
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('running subagents', () => {
	const task = (subtype: string) => Buffer.from(JSON.stringify({ type: 'system', subtype, task_id: 't1' }) + '\n');
	const settle = () => new Promise((r) => setTimeout(r, 0));

	// A session whose turn has ended with one subagent still running.
	async function withSubagent(id: string) {
		const child = await afterTurn(id);
		subagentIds.mockReturnValue(['t1']);
		child.stdout.emit('data', task('task_started'));
		await settle();
		return child;
	}

	it('publishes the count, and finishing the last one idles the session afresh and notifies', async () => {
		const id = `c_count_${seq}`;
		const child = await afterTurn(id);
		subagentIds.mockReturnValue(['t1', 't2']);
		child.stdout.emit('data', task('task_started'));
		await settle();
		expect(publishAgentEvent).toHaveBeenCalledWith(id, 'subagents', { subagents: 2 });
		vi.mocked(setSessionStatus).mockClear();
		vi.mocked(notify).mockClear();

		subagentIds.mockReturnValue([]);
		child.stdout.emit('data', task('task_notification'));
		await settle();
		expect(publishAgentEvent).toHaveBeenCalledWith(id, 'subagents', { subagents: 0 });
		expect(vi.mocked(setSessionStatus).mock.calls.at(-1)?.[1]).toBe('idle');
		expect(notify).toHaveBeenCalledWith(expect.objectContaining({ sessionId: id, unread: true, title: 'Subagents finished · t' }));
	});

	it('ends subagents a new process inherits from one deck never saw end', async () => {
		subagentIds.mockReturnValue(['ghost']);
		try {
			const child = fakeChild();
			spawnAgent.mockResolvedValueOnce(child);
			await claude.sendMessage(`c_ghost_${seq}`, 'one');
			expect(written().map((e) => e.type)).toEqual(['deck.user', 'deck.process-exit']);
		} finally {
			subagentIds.mockReturnValue([]);
		}
	});

	it('stays quiet when Stop ended them', async () => {
		const id = `c_quiet_${seq}`;
		const child = await withSubagent(id);
		expect(claude.interrupt(id)).toBe(true);
		vi.mocked(notify).mockClear();
		vi.mocked(setSessionStatus).mockClear();

		subagentIds.mockReturnValue([]);
		child.stdout.emit('data', task('task_notification'));
		await settle();
		expect(vi.mocked(setSessionStatus).mock.calls.at(-1)?.[1]).toBe('idle');
		expect(notify).not.toHaveBeenCalled();

		// A later turn's subagents finishing is news again.
		child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'stream_event', event: { type: 'message_start' } }) + '\n'));
		child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', subtype: 'success' }) + '\n'));
		subagentIds.mockReturnValue(['t2']);
		child.stdout.emit('data', task('task_started'));
		await settle();
		subagentIds.mockReturnValue([]);
		child.stdout.emit('data', task('task_notification'));
		await settle();
		expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Subagents finished · t' }));
	});

	it('force stop ends them: marks the transcript, drops the count, no notification', async () => {
		const id = `c_exit_${seq}`;
		const child = await withSubagent(id);
		vi.mocked(notify).mockClear();

		vi.mocked(setSessionStatus).mockClear();

		expect(claude.forceStop(id)).toBe(true);
		// The transcript records the end, so a later process's fold doesn't revive them.
		expect(written().at(-1)?.type).toBe('deck.process-exit');
		expect(vi.mocked(setSessionStatus).mock.calls.at(-1)?.[1]).toBe('idle');
		await settle();
		expect(publishAgentEvent).toHaveBeenCalledWith(id, 'subagents', { subagents: 0 });
		expect(notify).not.toHaveBeenCalled();
		subagentIds.mockReturnValue([]);
	});
});
