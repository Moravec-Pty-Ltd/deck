import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), listServers: vi.fn(), startServer: vi.fn() }));
vi.mock('$lib/server/sessions', () => ({ getSession: mocks.getSession }));
vi.mock('$lib/server/devservers', () => ({
	cachedServerStates: () => ({}),
	listServers: mocks.listServers,
	startServer: mocks.startServer,
	stopServer: vi.fn(),
	restartServer: vi.fn(),
	resetupServer: vi.fn(),
	runSetupStep: vi.fn(),
	serverLogs: vi.fn()
}));
const { GET } = await import('./+server');
const { POST } = await import('./[name]/+server');

beforeEach(() => vi.resetAllMocks());

async function rejection(run: () => unknown): Promise<number> {
	try {
		await run();
	} catch (e) {
		return (e as { status: number }).status;
	}
	throw new Error('expected a rejection');
}

function act(body: unknown) {
	const request = new Request('http://x', { method: 'POST', body: JSON.stringify(body) });
	return POST({ params: { id: 'c_1', name: 'web' }, request } as unknown as Parameters<typeof POST>[0]);
}

it('is a 404 for an unknown session', async () => {
	mocks.getSession.mockResolvedValue(undefined);
	expect(await rejection(() => GET({ params: { id: 'c_missing' } } as unknown as Parameters<typeof GET>[0]))).toBe(404);
	expect(mocks.listServers).not.toHaveBeenCalled();
});

it('lists the session servers', async () => {
	mocks.getSession.mockResolvedValue({ id: 'c_1', kind: 'claude' });
	mocks.listServers.mockResolvedValue([{ name: 'web', state: 'stopped' }]);
	const res = await GET({ params: { id: 'c_1' } } as unknown as Parameters<typeof GET>[0]);
	expect(await res.json()).toEqual({ servers: [{ name: 'web', state: 'stopped' }] });
});

it.each([[{ action: 'toString' }], [{ action: 'step', step: 'x' }], [{}]])('rejects %j with a 400', async (body) => {
	expect(await rejection(() => act(body))).toBe(400);
	expect(mocks.startServer).not.toHaveBeenCalled();
});

it('turns a failed action into a 400 with its message', async () => {
	mocks.startServer.mockRejectedValue(new Error('a bring-up is already in flight'));
	expect(await rejection(() => act({ action: 'start' }))).toBe(400);
	mocks.startServer.mockResolvedValue({ name: 'web', state: 'starting' });
	expect(await (await act({ action: 'start' })).json()).toEqual({ name: 'web', state: 'starting' });
});
