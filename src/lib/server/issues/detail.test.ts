import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionIssue } from '$lib/types';

const mocks = vi.hoisted(() => ({ gh: vi.fn(), linear: vi.fn(), cu: vi.fn(), comments: vi.fn() }));
vi.mock('./github', () => ({ gh: mocks.gh }));
vi.mock('./linear', () => ({ graphql: mocks.linear }));
vi.mock('./clickup', () => ({ cu: mocks.cu, clickupComments: mocks.comments, seg: (id: string) => encodeURIComponent(id) }));
vi.mock('node:fs', () => ({ default: { mkdirSync: vi.fn(), writeFileSync: vi.fn(), existsSync: () => false, readFileSync: () => '', appendFileSync: vi.fn() } }));
const { buildIssuePrompt } = await import('./detail');

const linear: SessionIssue = { source: 'linear', id: 'EX-1', url: 'https://example.test/EX-1' };
const clickup: SessionIssue = { source: 'clickup', id: '#abc', url: 'https://example.test/abc' };
const github: SessionIssue = { source: 'github', id: 'acme/web#7', url: 'https://example.test/7' };

beforeEach(() => {
	vi.resetAllMocks();
	mocks.cu.mockResolvedValue({ name: 'Task', markdown_description: 'Body' });
	mocks.comments.mockResolvedValue([{ comment_text: 'Older' }, { comment_text: 'Newer' }]);
	mocks.linear.mockResolvedValue({ issue: { title: 'Fix', description: 'Details', comments: { nodes: [] } } });
	mocks.gh.mockResolvedValue(JSON.stringify({ title: 'Bug', body: 'Steps', comments: [] }));
});

describe('issue detail fetch', () => {
	it('fetches ClickUp comments alongside the task', async () => {
		const context = await buildIssuePrompt('/path/to/project', [{ issue: clickup, apiKey: 'key' }]);
		expect(mocks.comments).toHaveBeenCalledWith('key', 'abc');
		expect(context.issueBody).toBe('Body');
		expect(context.issueComments).toBe('Older\n\nNewer');
		expect(context.warnings).toEqual([]);
	});
	it('keeps the ClickUp body when only the comment request fails', async () => {
		mocks.comments.mockRejectedValue(new Error('ClickUp API 500'));
		const context = await buildIssuePrompt('/path/to/project', [{ issue: clickup, apiKey: 'key' }]);
		expect(context.issueBody).toBe('Body');
		expect(context.issueComments).toBe('');
		expect(context.warnings).toEqual([]);
	});
	it('names an issue whose tracker has no credential', async () => {
		const context = await buildIssuePrompt('/path/to/project', [{ issue: linear }, { issue: github }]);
		expect(context.issueTitle).toBe('Bug');
		expect(context.warnings).toEqual(['no linear API key for EX-1']);
		expect(mocks.linear).not.toHaveBeenCalled();
	});
	it('reports a failed fetch with its reason and keeps the rest', async () => {
		mocks.gh.mockRejectedValue(new Error('gh: HTTP 404\nmore detail'));
		const context = await buildIssuePrompt('/path/to/project', [{ issue: github }, { issue: linear, apiKey: 'key' }]);
		expect(context.issueTitle).toBe('Fix');
		expect(context.warnings).toEqual(['github acme/web#7: gh: HTTP 404']);
	});
	it('reports an unknown Linear issue and a malformed GitHub id', async () => {
		mocks.linear.mockResolvedValue({ issue: null });
		const context = await buildIssuePrompt('/path/to/project', [
			{ issue: linear, apiKey: 'key' },
			{ issue: { source: 'github', id: 'not-a-ref', url: '' } }
		]);
		expect(context.warnings).toEqual(['Linear issue EX-1 not found', 'unrecognised GitHub issue id not-a-ref']);
	});
});
