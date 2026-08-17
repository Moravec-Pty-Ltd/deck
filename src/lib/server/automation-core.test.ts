import { describe, it, expect } from 'vitest';
import type { Issue, Project, PullRequest } from '$lib/types';
import {
	migrateReviewKeys,
	prIdentity,
	pruneSupersededReviewKeys,
	reviewBody,
	reviewTriggerKey,
	selectNewTriggers,
	workBody,
	workTriggerKey,
	type ProcessedKeys
} from './automation-core';

const issue = (over: Partial<Issue>): Issue => ({
	sourceId: 's1',
	sourceType: 'github',
	id: 'acme/web#42',
	title: 't',
	url: 'https://example.com',
	updatedAt: 0,
	blockers: [],
	...over
});

const pr = (over: Partial<PullRequest>): PullRequest => ({
	sourceId: 's1',
	repo: 'acme/web',
	number: 7,
	title: 't',
	url: 'https://example.com',
	headRefName: 'h',
	headRefOid: 'aaa',
	baseRefName: 'main',
	isDraft: false,
	author: 'someone',
	updatedAt: 0,
	...over
});

const project = (over: Partial<Project>): Project => ({
	name: 'web',
	path: '/path/to/web',
	...over
});

describe('trigger keys', () => {
	it('keys work by source type + issue id, not source id', () => {
		expect(workTriggerKey(issue({ id: 'acme/web#42' }))).toBe('auto:work:github:acme/web#42');
		expect(workTriggerKey(issue({ sourceType: 'linear', id: 'LIN-9' }))).toBe('auto:work:linear:LIN-9');
		// Same issue id from a differently-configured source shares the key.
		expect(workTriggerKey(issue({ sourceId: 'other' }))).toBe(workTriggerKey(issue({ sourceId: 's1' })));
	});

	it('keys review by repo + number + head sha, so a new head fires again', () => {
		expect(reviewTriggerKey(pr({ repo: 'acme/web', number: 7 }))).toBe('auto:review:acme/web#7@aaa');
		expect(reviewTriggerKey(pr({ headRefOid: 'bbb' }))).toBe('auto:review:acme/web#7@bbb');
	});
});

describe('selectNewTriggers', () => {
	it('skips already-processed keys', () => {
		const processed: ProcessedKeys = { 'auto:review:acme/web#7@aaa': 123 };
		const fresh = selectNewTriggers([pr({ number: 7 }), pr({ number: 8 })], reviewTriggerKey, processed);
		expect(fresh.map((f) => f.candidate.number)).toEqual([8]);
	});

	it('dedupes repeats within one batch', () => {
		const fresh = selectNewTriggers([pr({ number: 7 }), pr({ number: 7 })], reviewTriggerKey, {});
		expect(fresh).toHaveLength(1);
		expect(fresh[0].key).toBe('auto:review:acme/web#7@aaa');
	});

	it('preserves input order and pairs the key', () => {
		const fresh = selectNewTriggers(
			[issue({ id: 'acme/web#2' }), issue({ id: 'acme/web#1' })],
			workTriggerKey,
			{}
		);
		expect(fresh.map((f) => f.candidate.id)).toEqual(['acme/web#2', 'acme/web#1']);
		expect(fresh[0].key).toBe('auto:work:github:acme/web#2');
	});

	it('returns nothing for an empty feed', () => {
		expect(selectNewTriggers([], workTriggerKey, {})).toEqual([]);
	});
});

describe('review key migration and pruning', () => {
	it('re-keys a pre-#209 entry onto the head seen now, so nothing respawns on upgrade', () => {
		const processed: ProcessedKeys = { 'auto:review:acme/web#7': 123 };
		expect(migrateReviewKeys([pr({ headRefOid: 'aaa' })], processed)).toBe(true);
		expect(processed).toEqual({ 'auto:review:acme/web#7@aaa': 123 });
		// Migrated, so the current head is already processed but a later head is not.
		expect(selectNewTriggers([pr({ headRefOid: 'aaa' })], reviewTriggerKey, processed)).toEqual([]);
		expect(selectNewTriggers([pr({ headRefOid: 'bbb' })], reviewTriggerKey, processed)).toHaveLength(1);
	});

	it('leaves a ledger with no legacy entries untouched', () => {
		const processed: ProcessedKeys = { 'auto:review:acme/web#7@aaa': 1 };
		expect(migrateReviewKeys([pr({ headRefOid: 'aaa' })], processed)).toBe(false);
		expect(processed).toEqual({ 'auto:review:acme/web#7@aaa': 1 });
	});

	it('prunes older heads and a stray legacy entry for the same PR, keeping other PRs', () => {
		const processed: ProcessedKeys = {
			'auto:review:acme/web#7': 1,
			'auto:review:acme/web#7@aaa': 2,
			'auto:review:acme/web#7@bbb': 3,
			'auto:review:acme/web#8@aaa': 4,
			'auto:work:github:acme/web#7': 5
		};
		expect(pruneSupersededReviewKeys(processed, pr({ number: 7, headRefOid: 'bbb' }))).toBe(true);
		expect(processed).toEqual({
			'auto:review:acme/web#7@bbb': 3,
			'auto:review:acme/web#8@aaa': 4,
			'auto:work:github:acme/web#7': 5
		});
	});
});

describe('prIdentity', () => {
	it('identifies a PR by repo and number, independent of head', () => {
		expect(prIdentity(pr({ headRefOid: 'zzz' }))).toBe('acme/web#7');
	});
});

describe('workBody', () => {
	it('titles by the short issue id and branches by the full one, off the project base', () => {
		const body = workBody(
			project({ path: '/p', lastBase: 'develop', template: 'go' }),
			issue({ id: 'acme/web#42' })
		);
		expect(body.title).toBe('#42');
		expect(body.cwd).toBe('/p');
		expect(body.prompt).toBe('go');
		expect(body.worktree).toEqual({ branch: 'acme/web#42', newBranch: true, base: 'develop' });
	});

	it('falls back to the repo default base and an empty prompt when unset', () => {
		const body = workBody(project({}), issue({ sourceType: 'linear', id: 'LIN-9' }));
		expect(body.title).toBe('LIN-9');
		expect(body.prompt).toBe('');
		expect(body.worktree).toEqual({ branch: 'LIN-9', newBranch: true, base: undefined });
	});
});

describe('reviewBody', () => {
	it('titles by PR title and keeps the fromPr worktree', () => {
		const body = reviewBody(
			project({ path: '/p', reviewPrompt: 'review' }),
			pr({ number: 7, title: 'Fix the thing', baseRefName: 'main' })
		);
		expect(body.title).toBe('Fix the thing');
		expect(body.prompt).toBe('review');
		expect(body.worktree).toEqual({ fromPr: 7, base: 'main' });
	});
});
