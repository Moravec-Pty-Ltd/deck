import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	stableSnapshot: vi.fn(),
	sendKeys: vi.fn(),
	sendRawKey: vi.fn(),
	updateSession: vi.fn()
}));
vi.mock('$lib/server/sessions', () => ({ getSession: mocks.getSession, deleteSession: vi.fn() }));
vi.mock('$lib/server/tmux', () => ({
	stableSnapshot: mocks.stableSnapshot,
	snapshotTag: (text: string, cleared: boolean) => `${cleared ? 'c' : 'l'}${text.length}`,
	sendKeys: mocks.sendKeys,
	sendRawKey: mocks.sendRawKey
}));
vi.mock('$lib/server/store', () => ({ updateSession: mocks.updateSession }));
vi.mock('$lib/server/demo', () => ({ DEMO: false, demoTerminalText: () => '' }));
const { GET, POST } = await import('./+server');

const SHELL = { id: 's_1', kind: 'shell', status: 'idle', tmuxName: 'deck-s_1', managed: true };

beforeEach(() => vi.resetAllMocks());

function read(query = '') {
	const url = new URL(`http://example.test/api/agent/sessions/s_1/terminal${query}`);
	return GET({ params: { id: 's_1' }, url } as unknown as Parameters<typeof GET>[0]);
}

function drive(body: unknown) {
	const request = new Request('http://example.test/', { method: 'POST', body: JSON.stringify(body) });
	return POST({ params: { id: 's_1' }, request } as unknown as Parameters<typeof POST>[0]);
}

it('is a 404 for an unknown session', async () => {
	mocks.getSession.mockResolvedValue(undefined);
	await expect(read()).rejects.toMatchObject({ status: 404 });
	await expect(drive({ text: 'ls' })).rejects.toMatchObject({ status: 404 });
});

it('is a 400 for an agent session', async () => {
	mocks.getSession.mockResolvedValue({ id: 'c_1', kind: 'claude', status: 'idle' });
	await expect(read()).rejects.toMatchObject({ status: 400 });
	await expect(drive({ text: 'ls' })).rejects.toMatchObject({ status: 400 });
	expect(mocks.sendKeys).not.toHaveBeenCalled();
});

it('reads the pane with clamped lines, and says unchanged for a matching tag', async () => {
	mocks.getSession.mockResolvedValue(SHELL);
	mocks.stableSnapshot.mockResolvedValue({ text: 'hello', cleared: false });
	expect(await (await read('?lines=90000')).json()).toEqual({ text: 'hello', cleared: false, dead: false, h: 'l5' });
	expect(mocks.stableSnapshot).toHaveBeenCalledWith('deck-s_1', 5000);
	expect(await (await read('?h=l5')).json()).toEqual({ unchanged: true, h: 'l5' });
});

it('reports a dead pane without touching tmux', async () => {
	mocks.getSession.mockResolvedValue({ ...SHELL, status: 'dead' });
	expect(await (await read()).json()).toEqual({ text: '(session is dead)', dead: true });
	expect(mocks.stableSnapshot).not.toHaveBeenCalled();
});

it('types text, presses a key, and bumps a managed shell', async () => {
	mocks.getSession.mockResolvedValue(SHELL);
	expect(await (await drive({ text: 'ls', submit: false })).json()).toEqual({ ok: true });
	expect(mocks.sendKeys).toHaveBeenCalledWith('deck-s_1', 'ls', false);
	await drive({ key: 'C-c' });
	expect(mocks.sendRawKey).toHaveBeenCalledWith('deck-s_1', 'C-c');
	expect(mocks.updateSession).toHaveBeenCalledTimes(2);
});

it('rejects a key outside the allowlist', async () => {
	mocks.getSession.mockResolvedValue(SHELL);
	await expect(drive({ key: 'kill-server' })).rejects.toMatchObject({ status: 400 });
	expect(mocks.sendRawKey).not.toHaveBeenCalled();
});
