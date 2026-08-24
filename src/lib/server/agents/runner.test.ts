import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeckSession } from '$lib/types';

// A fake child: the two pipes and the exit/error signals runTurn listens on,
// plus a record of the signals sent to it.
class FakeChild extends EventEmitter {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	stdin = { end: vi.fn() };
	killed: string[] = [];
	kill(signal: string) {
		this.killed.push(signal);
		return true;
	}
}

const children = vi.hoisted(() => [] as any[]);
const spawn = vi.hoisted(() => vi.fn());

vi.mock('cross-spawn', () => ({ default: spawn }));
vi.mock('../claude', () => ({
	appendEvent: vi.fn(),
	setStatus: vi.fn(),
	bus: { emit: vi.fn() }
}));
vi.mock('../store', () => ({
	getStoredSession: vi.fn(() => undefined),
	updateSession: vi.fn()
}));
vi.mock('../push', () => ({ notify: vi.fn() }));
vi.mock('./env', () => ({ agentEnv: () => ({}) }));

const { appendEvent, setStatus } = await import('../claude');
const { notify } = await import('../push');
const runner = await import('./runner');

function session(id: string): DeckSession {
	return {
		id,
		kind: 'opencode',
		title: 't',
		cwd: '/tmp',
		createdAt: 0,
		lastActiveAt: 0,
		status: 'idle'
	};
}

// The result line the opencode driver maps to a `result` event, which is what
// sets runTurn's `sawResult`.
const RESULT_LINE = JSON.stringify({ type: 'step_finish', part: { reason: 'stop' } }) + '\n';

function statuses() {
	return vi.mocked(setStatus).mock.calls.map((c) => c[1]);
}

function appended(type: string) {
	return vi.mocked(appendEvent).mock.calls.filter((c) => (c[1] as any).type === type);
}

let seq = 0;

async function startTurn(id: string): Promise<FakeChild> {
	const child = new FakeChild();
	children.push(child);
	spawn.mockReturnValueOnce(child);
	await runner.runTurn(session(id), 'go');
	return child;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	children.length = 0;
	seq++;
});

afterEach(() => vi.useRealTimers());

describe('runTurn silence watchdog', () => {
	it('reports a stalled turn that produced nothing, so it stops looking like work in progress', async () => {
		const id = `s_stall_${seq}`;
		const child = await startTurn(id);
		child.stderr.emit('data', Buffer.from('connect ECONNREFUSED\n'));

		expect(runner.turnRunning(id)).toBe(true);
		await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

		expect(child.killed).toEqual(['SIGTERM']);
		expect(statuses()).toEqual(['running', 'error']);
		expect(runner.turnRunning(id)).toBe(false);
		const [errorEvent] = appended('deck.error');
		expect((errorEvent[1] as any).text).toContain('connect ECONNREFUSED');
		expect((errorEvent[1] as any).text).toContain('no output from opencode for 30m');
		expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining('crashed') }));
	});

	it('does not trip while the child is still producing output', async () => {
		const id = `s_healthy_${seq}`;
		const child = await startTurn(id);
		for (let i = 0; i < 6; i++) {
			await vi.advanceTimersByTimeAsync(25 * 60 * 1000);
			child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'step_start' }) + '\n'));
		}
		expect(child.killed).toEqual([]);
		expect(statuses()).toEqual(['running']);
	});

	it('counts stderr as liveness, for an agent that logs its progress there', async () => {
		const id = `s_stderr_${seq}`;
		const child = await startTurn(id);
		for (let i = 0; i < 6; i++) {
			await vi.advanceTimersByTimeAsync(25 * 60 * 1000);
			child.stderr.emit('data', Buffer.from('still building\n'));
		}
		expect(child.killed).toEqual([]);
		expect(statuses()).toEqual(['running']);
	});

	it('reports a stall with no stderr at all, the usual shape of a wedged socket', async () => {
		const id = `s_silent_${seq}`;
		const child = await startTurn(id);
		await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

		const [errorEvent] = appended('deck.error');
		expect((errorEvent[1] as any).text).toBe('no output from opencode for 30m; stopped the stalled turn');
	});

	it('calls a wedged-but-finished turn done rather than crashed', async () => {
		const id = `s_result_${seq}`;
		const child = await startTurn(id);
		child.stdout.emit('data', Buffer.from(RESULT_LINE));

		await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

		expect(child.killed).toEqual(['SIGTERM']);
		expect(statuses()).toEqual(['running', 'idle']);
		expect(appended('deck.error')).toHaveLength(0);
		expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining('Finished') }));
	});

	it('stops watching once the child exits on its own', async () => {
		const id = `s_exit_${seq}`;
		const child = await startTurn(id);
		child.emit('exit', 0, null);
		vi.mocked(setStatus).mockClear();

		expect(vi.getTimerCount()).toBe(0); // no 30m timer left pinning the turn's closure
		await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
		expect(child.killed).toEqual([]);
		expect(statuses()).toEqual([]);
	});
});

describe('runTurn supersede', () => {
	it('lets a stalled older child neither report nor kill the turn that replaced it', async () => {
		const id = `s_super_${seq}`;
		const first = await startTurn(id);
		await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
		const second = await startTurn(id);
		vi.mocked(setStatus).mockClear();
		vi.mocked(notify).mockClear();

		// The first child's watchdog now trips while the second turn is live.
		await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

		expect(second.killed).toEqual([]);
		expect(statuses()).toEqual([]);
		expect(notify).not.toHaveBeenCalled();
		expect(runner.turnRunning(id)).toBe(true);
		expect(first.killed).toEqual(['SIGTERM']); // only the one runTurn sent on supersede
	});

	it('drops a superseded child\'s trailing output instead of filing it under the live turn', async () => {
		const id = `s_drain_${seq}`;
		const first = await startTurn(id);
		await startTurn(id);
		vi.mocked(appendEvent).mockClear();
		vi.mocked(setStatus).mockClear();

		// Bytes already in flight when runTurn signalled it, drained afterwards.
		first.stdout.emit('data', Buffer.from(RESULT_LINE));
		first.emit('exit', null, 'SIGTERM');

		expect(appendEvent).not.toHaveBeenCalled();
		expect(statuses()).toEqual([]);
		expect(runner.turnRunning(id)).toBe(true);
	});
});
