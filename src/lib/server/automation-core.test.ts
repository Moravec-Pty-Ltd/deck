import { describe, it, expect } from 'vitest';
import type { Issue, PullRequest } from '$lib/types';
import { reviewTriggerKey, selectNewTriggers, workTriggerKey, type ProcessedKeys } from './automation-core';

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
	baseRefName: 'main',
	isDraft: false,
	author: 'someone',
	updatedAt: 0,
	...over
});

describe('trigger keys', () => {
	it('keys work by source type + issue id, not source id', () => {
		expect(workTriggerKey(issue({ id: 'acme/web#42' }))).toBe('auto:work:github:acme/web#42');
		expect(workTriggerKey(issue({ sourceType: 'linear', id: 'LIN-9' }))).toBe('auto:work:linear:LIN-9');
		// Same issue id from a differently-configured source shares the key.
		expect(workTriggerKey(issue({ sourceId: 'other' }))).toBe(workTriggerKey(issue({ sourceId: 's1' })));
	});

	it('keys review by repo + number', () => {
		expect(reviewTriggerKey(pr({ repo: 'acme/web', number: 7 }))).toBe('auto:review:acme/web#7');
	});
});

describe('selectNewTriggers', () => {
	it('skips already-processed keys', () => {
		const processed: ProcessedKeys = { 'auto:review:acme/web#7': 123 };
		const fresh = selectNewTriggers([pr({ number: 7 }), pr({ number: 8 })], reviewTriggerKey, processed);
		expect(fresh.map((f) => f.candidate.number)).toEqual([8]);
	});

	it('dedupes repeats within one batch', () => {
		const fresh = selectNewTriggers([pr({ number: 7 }), pr({ number: 7 })], reviewTriggerKey, {});
		expect(fresh).toHaveLength(1);
		expect(fresh[0].key).toBe('auto:review:acme/web#7');
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
