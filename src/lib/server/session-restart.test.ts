import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeckSession } from '$lib/types';

const mocks = vi.hoisted(() => ({ get: vi.fn(), running: vi.fn(), stop: vi.fn(), append: vi.fn() }));
vi.mock('./store', () => ({ getStoredSession: mocks.get }));
vi.mock('./agents/dispatch', () => ({ agentTurnRunning: mocks.running }));
vi.mock('./claude', () => ({ stopProcess: mocks.stop, appendEvent: mocks.append }));
const { restartSession } = await import('./session-restart');

const restart = () => restartSession({ params: { id: 'example' } });

beforeEach(() => {
	vi.resetAllMocks();
	mocks.get.mockReturnValue({ id: 'example', kind: 'claude' } as DeckSession);
	mocks.running.mockReturnValue(false);
});

describe('restart route', () => {
	it('drops the idle process and marks the transcript', async () => {
		expect((await restart()).status).toBe(200);
		expect(mocks.stop).toHaveBeenCalledWith('example');
		expect(mocks.append).toHaveBeenCalledWith('example', expect.objectContaining({ type: 'deck.restart' }));
	});
	it('always acts: a second restart is not a no-op', async () => {
		await restart();
		await restart();
		expect(mocks.stop).toHaveBeenCalledTimes(2);
		expect(mocks.append).toHaveBeenCalledTimes(2);
	});
	it('409s while a turn is running and leaves the turn alone', async () => {
		mocks.running.mockReturnValue(true);
		await expect(restart()).rejects.toMatchObject({ status: 409 });
		expect(mocks.stop).not.toHaveBeenCalled();
		expect(mocks.append).not.toHaveBeenCalled();
	});
	it('400s for kinds without a persistent process', async () => {
		for (const kind of ['pi', 'codex', 'opencode', 'shell']) {
			mocks.get.mockReturnValue({ id: 'example', kind } as DeckSession);
			await expect(restart()).rejects.toMatchObject({ status: 400 });
		}
		expect(mocks.stop).not.toHaveBeenCalled();
	});
	it('404s an unknown session', async () => {
		mocks.get.mockReturnValue(undefined);
		await expect(restart()).rejects.toMatchObject({ status: 404 });
		expect(mocks.stop).not.toHaveBeenCalled();
	});
});
