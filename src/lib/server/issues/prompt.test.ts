import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PickedIssue } from './prompt';

const mocks = vi.hoisted(() => ({ root: vi.fn(), project: vi.fn(), projects: vi.fn(), secret: vi.fn(), issues: vi.fn(), build: vi.fn() }));
vi.mock('../confine', () => ({ resolveWithinProjects: mocks.root, projectForPath: mocks.project }));
vi.mock('../store', () => ({ listProjects: mocks.projects, readSecret: mocks.secret }));
vi.mock('./index', () => ({ getProjectIssues: mocks.issues }));
vi.mock('./detail', () => ({ buildIssuePrompt: mocks.build }));
const { issuePromptContext } = await import('./prompt');

const picked: PickedIssue = { issue: { source: 'linear', id: 'EX-1', url: '' }, sourceId: '' };
const source = { id: 'source-a', type: 'linear' };
beforeEach(() => {
	vi.resetAllMocks();
	mocks.root.mockReturnValue('/path/to/project-worktrees/task');
	mocks.project.mockReturnValue('/path/to/project');
	mocks.projects.mockReturnValue([{ path: '/path/to/project', sources: [source] }]);
	mocks.secret.mockReturnValue('example-key');
	mocks.build.mockResolvedValue({ issueTitle: 'Fix', issueBody: 'Details', issueComments: 'Discussion' });
});

describe('shared issue prompt context', () => {
	it('resolves a legacy client issue through its worktree project', async () => {
		expect(await issuePromptContext('/path/to/project-worktrees/task', [picked])).toEqual({
			issueTitle: 'Fix', issueBody: 'Details', issueComments: 'Discussion'
		});
		expect(mocks.secret).toHaveBeenCalledWith('source-a');
		expect(mocks.build).toHaveBeenCalledWith('/path/to/project-worktrees/task', [{ issue: picked.issue, apiKey: 'example-key' }]);
	});
	it('preserves an explicitly selected source', async () => {
		await issuePromptContext('/path/to/project', [{ ...picked, sourceId: 'source-b' }]);
		expect(mocks.secret).toHaveBeenCalledWith('source-b');
		expect(mocks.issues).not.toHaveBeenCalled();
	});
	it('matches discovery when several accounts share a tracker', async () => {
		mocks.projects.mockReturnValue([{ path: '/path/to/project', sources: [source, { ...source, id: 'source-b' }] }]);
		mocks.issues.mockResolvedValue({ issues: [{ sourceType: 'linear', id: 'EX-1', sourceId: 'source-b' }] });
		await issuePromptContext('/path/to/project', [picked]);
		expect(mocks.secret).toHaveBeenCalledWith('source-b');
	});
	it('does not guess between ambiguous accounts', async () => {
		mocks.projects.mockReturnValue([{ path: '/path/to/project', sources: [source, { ...source, id: 'source-b' }] }]);
		mocks.issues.mockResolvedValue({ issues: ['source-a', 'source-b'].map((sourceId) => ({ sourceType: 'linear', id: 'EX-1', sourceId })) });
		await issuePromptContext('/path/to/project', [picked]);
		expect(mocks.secret).not.toHaveBeenCalled();
	});
	it('fetches GitHub context without looking up a credential', async () => {
		await issuePromptContext('/path/to/project', [{ issue: { source: 'github', id: 'acme/web#1', url: '' }, sourceId: '' }]);
		expect(mocks.secret).not.toHaveBeenCalled();
		expect(mocks.build).toHaveBeenCalled();
	});
	it('never fetches or writes assets outside registered projects', async () => {
		mocks.root.mockReturnValue(null);
		expect(await issuePromptContext('/path/to/other', [picked])).toEqual({});
		expect(mocks.build).not.toHaveBeenCalled();
	});
	it('keeps context failures best effort', async () => {
		mocks.build.mockRejectedValue(new Error('offline'));
		expect(await issuePromptContext('/path/to/project', [picked])).toEqual({});
	});
});
