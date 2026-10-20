import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), refreshPrOnOpen: vi.fn() }));
vi.mock('$lib/server/sessions', () => ({ getSession: mocks.getSession }));
vi.mock('$lib/server/pr', () => ({ refreshPrOnOpen: mocks.refreshPrOnOpen }));
vi.mock('$lib/server/claude', () => ({ bus: { on: vi.fn(), off: vi.fn() }, snapshotFrames: () => [] }));
vi.mock('$lib/server/agents/dispatch', () => ({ agentTurnRunning: () => false }));
vi.mock('$lib/server/demo', () => ({ DEMO: false, demoTranscript: () => [] }));
const { GET } = await import('./+server');

beforeEach(() => vi.resetAllMocks());

function open(id: string) {
	return GET({ params: { id } } as unknown as Parameters<typeof GET>[0]);
}

async function rejection(run: () => unknown): Promise<number> {
	try {
		await run();
	} catch (e) {
		return (e as { status: number }).status;
	}
	throw new Error('expected a rejection');
}

it('is a 404 for an unknown session', async () => {
	mocks.getSession.mockResolvedValue(undefined);
	expect(await rejection(() => open('c_missing'))).toBe(404);
});

it('is a 400 for a shell session', async () => {
	mocks.getSession.mockResolvedValue({ id: 's_1', kind: 'shell', status: 'idle' });
	expect(await rejection(() => open('s_1'))).toBe(400);
	expect(mocks.refreshPrOnOpen).not.toHaveBeenCalled();
});

it('streams an agent session and refreshes its PR on open', async () => {
	mocks.getSession.mockResolvedValue({ id: 'c_1', kind: 'claude', status: 'idle' });
	const res = await open('c_1');
	expect(res.headers.get('content-type')).toBe('text/event-stream');
	expect(mocks.refreshPrOnOpen).toHaveBeenCalledWith('c_1');
	await res.body?.cancel();
});
