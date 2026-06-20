import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	clickupSpaces,
	clickupFolders,
	clickupLists,
	clickupStatuses,
	fetchClickupIssues
} from './clickup';
import type { ClickupSource } from '$lib/types';

const API = 'https://api.clickup.com/api/v2';

// An id that, interpolated raw, would escape its path segment against the host.
const NASTY = '../../evil?x#y';
const ENC = encodeURIComponent(NASTY);

// Record every outbound URL while returning canned JSON keyed off the path.
function stubFetch(routes: (url: string) => unknown): string[] {
	const calls: string[] = [];
	const fetchMock = vi.fn(async (url: string) => {
		calls.push(url);
		return {
			ok: true,
			status: 200,
			text: async () => JSON.stringify(routes(url) ?? {})
		} as Response;
	});
	vi.stubGlobal('fetch', fetchMock);
	return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('clickup path-id encoding', () => {
	it('encodes the team id when listing spaces', async () => {
		const calls = stubFetch(() => ({ spaces: [] }));
		await clickupSpaces('key', NASTY);
		expect(calls[0]).toBe(`${API}/team/${ENC}/space?archived=false`);
		// The security property itself: the chars that could reshape the request
		// path against the fixed host (`/`, `?`, `#`) don't survive in the segment.
		// `.` is left as-is by encodeURIComponent, but `..` is inert once its `/` is
		// encoded, so a bare `..` is harmless.
		const segment = calls[0].slice(`${API}/team/`.length, calls[0].indexOf('/space'));
		expect(segment).not.toMatch(/[/?#]/);
	});

	it('encodes the space id when listing folders', async () => {
		const calls = stubFetch(() => ({ folders: [] }));
		await clickupFolders('key', NASTY);
		expect(calls[0]).toBe(`${API}/space/${ENC}/folder?archived=false`);
	});

	it('encodes the folder id for folder-scoped lists', async () => {
		const calls = stubFetch(() => ({ lists: [] }));
		await clickupLists('key', { folderId: NASTY });
		expect(calls[0]).toBe(`${API}/folder/${ENC}/list?archived=false`);
	});

	it('encodes the space id for folderless lists', async () => {
		const calls = stubFetch(() => ({ lists: [] }));
		await clickupLists('key', { spaceId: NASTY });
		expect(calls[0]).toBe(`${API}/space/${ENC}/list?archived=false`);
	});

	it('rejects a list scope with neither folder nor space', () => {
		const calls = stubFetch(() => ({ lists: [] }));
		expect(() => clickupLists('key', {})).toThrow(/folderId or spaceId/);
		expect(calls).toHaveLength(0);
	});

	it('encodes the list id when reading statuses', async () => {
		const calls = stubFetch(() => ({ statuses: [] }));
		await clickupStatuses('key', NASTY);
		expect(calls[0]).toBe(`${API}/list/${ENC}`);
	});

	it('encodes the list id and resolved blocker ids when fetching issues', async () => {
		const source: ClickupSource = {
			id: 'src1',
			type: 'clickup',
			teamId: 't',
			teamName: 'T',
			spaceId: 's',
			spaceName: 'S',
			listId: NASTY,
			listName: 'L',
			statuses: ['open'],
			assigneeUserId: 42
		};
		const calls = stubFetch((url) =>
			url.includes('/task?')
				? {
						tasks: [
							{
								id: 'task1',
								name: 'Task',
								url: 'u',
								status: { status: 'open', type: 'open' },
								date_updated: '1700000000000',
								dependencies: [{ task_id: 'task1', depends_on: NASTY }]
							}
						]
					}
				: {
						id: 'task1',
						name: 'Blocker',
						url: 'u',
						status: { status: 'open', type: 'open' },
						date_updated: '0'
					}
		);

		await fetchClickupIssues(source, 'key');

		expect(calls[0]).toContain(`${API}/list/${ENC}/task?`);
		expect(calls).toContain(`${API}/task/${ENC}`);
	});
});
