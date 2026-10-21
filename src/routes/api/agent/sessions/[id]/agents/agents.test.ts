import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), hasProcess: vi.fn(), sessionAgents: vi.fn() }));
vi.mock('$lib/server/sessions', () => ({ getSession: mocks.getSession }));
vi.mock('$lib/server/claude', () => ({
	bus: { on: vi.fn(), off: vi.fn() },
	snapshotFrames: () => [],
	hasProcess: mocks.hasProcess,
	sessionAgents: mocks.sessionAgents
}));
vi.mock('$lib/server/demo', () => ({ DEMO: false, demoTranscript: () => [] }));
const { GET } = await import('./+server');
const { GET: browserGET } = await import('../../../../sessions/[id]/agents/+server');

beforeEach(() => vi.resetAllMocks());

function open(id: string) {
	return GET({ params: { id } } as unknown as Parameters<typeof GET>[0]);
}

it('is a 404 for an unknown session', async () => {
	mocks.getSession.mockResolvedValue(undefined);
	await expect(open('c_missing')).rejects.toMatchObject({ status: 404 });
});

it("reads a claude session's agents as stopped when it has no process", async () => {
	mocks.getSession.mockResolvedValue({ id: 'c_1', kind: 'claude' });
	mocks.hasProcess.mockReturnValue(false);
	mocks.sessionAgents.mockReturnValue({ tasks: {}, byCall: {}, callIndex: {} });
	const res = await open('c_1');
	expect(await res.json()).toEqual({ tasks: {}, byCall: {}, callIndex: {} });
	expect(mocks.sessionAgents).toHaveBeenCalledWith('c_1', false);
});

it('is the same handler as the browser route', () => {
	expect(browserGET).toBe(GET);
});
