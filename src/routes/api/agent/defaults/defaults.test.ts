import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ projects: vi.fn(), settings: vi.fn() }));
vi.mock('$lib/server/store', () => ({ listProjects: mocks.projects, readSettings: mocks.settings }));
vi.mock('$lib/server/fsutil', () => ({ expandTilde: (value: string) => value.replace(/^~/, '/home/example') }));
const { GET } = await import('./+server');

beforeEach(() => {
	vi.resetAllMocks();
	mocks.projects.mockReturnValue([{ name: 'web', path: '/home/example/web', lastBase: 'main', template: 'Fix [issue_body]' }]);
	mocks.settings.mockReturnValue({ lastModels: { claude: { model: 'sonnet' } } });
});

function get(query: string) {
	return GET({ url: new URL(`http://example.test/api/agent/defaults${query}`) } as Parameters<typeof GET>[0]);
}

it('publishes the resolved defaults for a registered project', async () => {
	const body = await (await get('?project=~/web/')).json();
	expect(body.base).toBe('main');
	expect(body.prompts).toEqual({ work: 'Fix [issue_body]' });
	expect(body.kinds.claude).toEqual({ model: 'sonnet', permissionMode: 'bypassPermissions' });
});

it('rejects a missing or unknown project', async () => {
	await expect(get('')).rejects.toMatchObject({ status: 400 });
	await expect(get('?project=/elsewhere')).rejects.toMatchObject({ status: 404 });
});
