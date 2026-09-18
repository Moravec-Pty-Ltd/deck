import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ create: vi.fn(), projects: vi.fn() }));
vi.mock('$lib/server/sessions', () => ({ listSessions: vi.fn() }));
vi.mock('$lib/server/create-session', () => ({ createSessionFromRequest: mocks.create, parsePr: vi.fn() }));
vi.mock('$lib/server/agent-digest', () => ({ sessionDigest: vi.fn() }));
vi.mock('$lib/server/http', () => ({ objectBody: (request: Request) => request.json() }));
vi.mock('$lib/server/idempotency', () => ({ runIdempotent: (_key: unknown, run: () => unknown) => ({ replay: false, result: run() }) }));
vi.mock('$lib/server/config', () => ({ baseUrl: 'http://example.test' }));
vi.mock('$lib/server/store', () => ({ listProjects: mocks.projects }));
vi.mock('$lib/server/confine', () => ({ projectForPath: () => '/path/to/project' }));
vi.mock('$lib/server/fsutil', () => ({ expandTilde: (value: string) => value }));
const { POST } = await import('./+server');

beforeEach(() => {
	vi.resetAllMocks();
	mocks.create.mockResolvedValue({ id: 'example' });
	mocks.projects.mockReturnValue([{ path: '/path/to/project', template: 'Fix [issue_body]\n[issue_comments]' }]);
});

async function create(body: Record<string, unknown>) {
	return POST({ request: new Request('http://example.test/api/agent/sessions', {
		method: 'POST', body: JSON.stringify({ mode: 'work', cwd: '/path/to/project', ...body })
	}) } as Parameters<typeof POST>[0]);
}

it('passes multiple issues and the raw project template to the shared pipeline', async () => {
	const issues = [1, 2].map((id) => ({ source: 'linear', sourceId: 'source-a', id: `EX-${id}`, url: '' }));
	expect((await create({ issues, issue: { id: 'ignored' } })).status).toBe(201);
	expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ issues, prompt: 'Fix [issue_body]\n[issue_comments]' }));
});

it('retains the legacy single issue and an explicit raw prompt', async () => {
	const issue = { source: 'linear', id: 'EX-1', url: '' };
	await create({ issue, prompt: '[issue_title]: [issue_body]' });
	expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ issues: [issue], prompt: '[issue_title]: [issue_body]' }));
});
