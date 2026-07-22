import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DeckSession, Issue, Project, PullRequest } from '$lib/types';
import { pinEnv } from './test-env';

// agent-digest pulls baseUrl/config and the transcript reader, both of which
// derive state from the env at import time; pin throwaway values first.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-digest-'));
const restoreEnv = pinEnv({ DECK_DATA: tmpDir, DECK_BASE_URL: 'http://example.test:4818' });

const { sessionDigest, projectDigest, issueDigest, prDigest } = await import('./agent-digest');

afterAll(() => {
	restoreEnv();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function session(over: Partial<DeckSession> = {}): DeckSession {
	return {
		id: 'c_abc123',
		kind: 'claude',
		title: 'work',
		cwd: '/tmp/work',
		createdAt: 1,
		lastActiveAt: 2,
		status: 'idle',
		...over
	};
}

describe('sessionDigest', () => {
	it('projects the monitor-facing fields and builds the session url', () => {
		const d = sessionDigest(session({ awaitingInput: true, model: 'opus' }));
		expect(d).toMatchObject({
			id: 'c_abc123',
			url: 'http://example.test:4818/s/c_abc123',
			status: 'idle',
			awaitingInput: true,
			model: 'opus'
		});
	});

	it('drops internal plumbing fields', () => {
		const d = sessionDigest(
			session({ tmuxName: 'deck-x', prBackfilled: true, claudeSessionId: 'sess' })
		) as unknown as Record<string, unknown>;
		expect(d.tmuxName).toBeUndefined();
		expect(d.prBackfilled).toBeUndefined();
		expect(d.claudeSessionId).toBeUndefined();
	});

	it('includes an (empty) cost summary for a transcript-less agent session', () => {
		expect(sessionDigest(session()).cost).toEqual({
			costUsd: 0,
			turns: 0,
			durationMs: 0,
			results: 0
		});
	});

	it('omits cost for shells and folds legacy single issue into issues', () => {
		const shell = sessionDigest(
			session({ kind: 'shell', issue: { source: 'github', id: 'a/b#1', url: '' } })
		);
		expect(shell.cost).toBeUndefined();
		expect(shell.issues).toEqual([{ source: 'github', id: 'a/b#1', url: '' }]);
	});

	it('normalises absent awaitingInput to false', () => {
		expect(sessionDigest(session()).awaitingInput).toBe(false);
	});

	it('omits lastResult unless requested, and reads null for a transcript-less session', () => {
		expect(sessionDigest(session()).lastResult).toBeUndefined();
		expect(sessionDigest(session(), { lastResult: true }).lastResult).toBeNull();
	});
});

describe('discovery projections', () => {
	it('projects a project to { path, name, group }, dropping stored internals', () => {
		const project = {
			name: 'web',
			path: '/path/to/web',
			group: 'apps',
			sources: [{ id: 's1', type: 'github', owner: 'acme', repo: 'web' }],
			dev: { ports: [] }
		} as unknown as Project;
		expect(projectDigest(project)).toEqual({ path: '/path/to/web', name: 'web', group: 'apps' });
	});

	it('maps an issue row onto create\'s issue shape', () => {
		const issue: Issue = {
			sourceId: 's1',
			sourceType: 'github',
			id: 'acme/web#12',
			title: 'Fix it',
			url: 'https://github.com/acme/web/issues/12',
			updatedAt: 0,
			blockers: []
		};
		expect(issueDigest(issue)).toEqual({
			source: 'github',
			id: 'acme/web#12',
			title: 'Fix it',
			url: 'https://github.com/acme/web/issues/12'
		});
	});

	it('maps a PR row onto review\'s pr shape plus context', () => {
		const pr: PullRequest = {
			sourceId: 's1',
			repo: 'acme/web',
			number: 42,
			title: 'A change',
			url: 'https://github.com/acme/web/pull/42',
			headRefName: 'feat',
			baseRefName: 'main',
			isDraft: false,
			author: 'someone',
			updatedAt: 0
		};
		expect(prDigest(pr)).toMatchObject({ repo: 'acme/web', number: 42, headRefName: 'feat', baseRefName: 'main' });
	});
});
