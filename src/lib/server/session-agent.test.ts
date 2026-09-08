import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeckSession } from '$lib/types';

const mocks = vi.hoisted(() => ({
	get: vi.fn(), update: vi.fn(), running: vi.fn(), available: vi.fn(), stop: vi.fn(), append: vi.fn(), drain: vi.fn(), transcript: vi.fn()
}));
vi.mock('./sessions', () => ({ getSession: vi.fn(), deleteSession: vi.fn() }));
vi.mock('./store', () => ({ getStoredSession: mocks.get, updateSession: mocks.update }));
vi.mock('./agents/dispatch', () => ({ agentTurnRunning: mocks.running }));
vi.mock('./agents/available', () => ({ agentAvailability: mocks.available }));
vi.mock('./claude', () => ({ stopProcess: mocks.stop, appendEvent: mocks.append }));
vi.mock('./transcript', () => ({ agentTranscriptView: mocks.transcript, transcriptPath: (id: string) => id }));
vi.mock('./transcript-writer', () => ({ whenDrained: mocks.drain }));
const { changeSessionAgent } = await import('./session-agent');

function change(kind: unknown) {
	return changeSessionAgent({ params: { id: 'example' }, request: new Request('http://localhost/api/sessions/example/agent', { method: 'POST', body: JSON.stringify({ kind }) }) });
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.get.mockReturnValue({ id: 'example', kind: 'claude', cwd: '/path/to/project' } as DeckSession);
	mocks.available.mockResolvedValue({ claude: true, codex: true, pi: true, opencode: true });
	mocks.transcript.mockReturnValue({ messages: [{ role: 'user', text: 'Keep the changes small' }] });
});

describe('switch agent route', () => {
	it('keeps the deck identity while replacing the native runtime', async () => {
		expect((await change('codex')).status).toBe(200);
		expect(mocks.stop).toHaveBeenCalledWith('example');
		expect(mocks.update).toHaveBeenCalledWith('example', expect.objectContaining({ kind: 'codex', claudeSessionId: undefined, agentSessionId: undefined, pendingHandoff: expect.stringContaining('Keep the changes small') }));
		expect(mocks.append).toHaveBeenCalledWith('example', expect.objectContaining({ type: 'deck.agent', from: 'claude', kind: 'codex' }));
	});
	it('rejects a turn that starts during the availability probe', async () => {
		mocks.available.mockImplementation(async () => { mocks.running.mockReturnValue(true); return { codex: true }; });
		await expect(change('codex')).rejects.toMatchObject({ status: 409 });
		expect(mocks.stop).not.toHaveBeenCalled();
		expect(mocks.update).not.toHaveBeenCalled();
	});
	it('rejects unavailable agents', async () => {
		mocks.available.mockResolvedValue({ codex: false });
		await expect(change('codex')).rejects.toMatchObject({ status: 400 });
		expect(mocks.update).not.toHaveBeenCalled();
	});
	it('does nothing when reselecting the current agent', async () => {
		await change('claude');
		expect(mocks.update).not.toHaveBeenCalled();
		expect(mocks.append).not.toHaveBeenCalled();
	});
	it('rejects shells and unknown agents', async () => {
		await expect(change('unknown')).rejects.toMatchObject({ status: 400 });
		mocks.get.mockReturnValue({ id: 'example', kind: 'shell' });
		await expect(change('codex')).rejects.toMatchObject({ status: 400 });
	});
});
