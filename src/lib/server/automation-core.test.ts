import { describe, it, expect } from 'vitest';
import type { Issue, Project, PullRequest, SessionStatus } from '$lib/types';
import {
	agentFields,
	parseAutomation,
	atReviewCap,
	migrateReviewKeys,
	prIdentity,
	pruneSupersededReviewKeys,
	reviewBody,
	reviewOrder,
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

describe('agentFields', () => {
	it('is claude with nothing set when the project remembers nothing', () => {
		expect(agentFields(project({}))).toEqual({ kind: 'claude', model: undefined, provider: undefined, effort: undefined });
	});

	it('prefers the configured pick over the remembered one, field by field', () => {
		const p = project({ lastModels: { claude: { model: 'sonnet' } }, lastEffort: 'high' });
		expect(agentFields(p, { kind: 'claude', model: 'local' })).toMatchObject({ model: 'local', effort: 'high' });
		expect(agentFields(p, { kind: 'claude', effort: 'low' })).toMatchObject({ model: 'sonnet', effort: 'low' });
	});

	it('treats a blank configured model as unset rather than as the CLI default', () => {
		const p = project({ lastModels: { claude: { model: 'sonnet' } } });
		expect(agentFields(p, { kind: 'claude', model: '' }).model).toBe('sonnet');
	});
});

describe('automation agent config', () => {
	it('defaults to claude with no model or effort when nothing is configured', () => {
		const body = workBody(project({}), issue({}));
		expect(body.kind).toBe('claude');
		expect(body.model).toBeUndefined();
		expect(body.provider).toBeUndefined();
		expect(body.effort).toBeUndefined();
	});

	it("uses the project's remembered pick when automation names none", () => {
		const p = project({ lastModels: { claude: { model: 'sonnet' } }, lastEffort: 'high' });
		expect(workBody(p, issue({}))).toMatchObject({ kind: 'claude', model: 'sonnet', effort: 'high' });
		expect(reviewBody(p, pr({}))).toMatchObject({ kind: 'claude', model: 'sonnet', effort: 'high' });
	});

	it('lets the configured pick win over the remembered one, per lane', () => {
		const p = project({
			lastModels: { claude: { model: 'sonnet' } },
			lastEffort: 'high',
			automation: {
				review: true,
				reviewAgent: { kind: 'claude', model: 'local-profile', effort: 'low' },
				workAgent: { kind: 'claude', effort: 'max' }
			}
		});
		expect(reviewBody(p, pr({}))).toMatchObject({ kind: 'claude', model: 'local-profile', effort: 'low' });
		// work names only an effort, so the remembered model still applies.
		expect(workBody(p, issue({}))).toMatchObject({ kind: 'claude', model: 'sonnet', effort: 'max' });
	});

	it("takes the remembered pi pick whole, since a provider hosts particular models", () => {
		const p = project({ lastModels: { pi: { provider: 'openrouter', model: 'kimi' } } });
		// Naming either half opts out of the remembered pair rather than mixing them.
		expect(agentFields(p, { kind: 'pi', model: 'qwen' })).toMatchObject({ model: 'qwen', provider: undefined });
		expect(agentFields(p, { kind: 'pi', provider: 'local' })).toMatchObject({ model: undefined, provider: 'local' });
		expect(agentFields(p, { kind: 'pi' })).toMatchObject({ model: 'kimi', provider: 'openrouter' });
	});

	it('carries a pi provider and model, and reads the remembered pi pick for the same kind', () => {
		const configured = project({ automation: { review: true, reviewAgent: { kind: 'pi', provider: 'local', model: 'qwen' } } });
		expect(reviewBody(configured, pr({}))).toMatchObject({ kind: 'pi', provider: 'local', model: 'qwen' });
		const remembered = project({
			lastModels: { claude: { model: 'opus' }, pi: { provider: 'local', model: 'qwen' } },
			automation: { review: true, reviewAgent: { kind: 'pi' } }
		});
		expect(reviewBody(remembered, pr({}))).toMatchObject({ kind: 'pi', provider: 'local', model: 'qwen' });
	});

	it("doesn't leak a remembered claude effort onto another kind, but passes a configured one through to be rejected", () => {
		const p = project({ lastEffort: 'high', automation: { review: true, reviewAgent: { kind: 'codex' } } });
		expect(reviewBody(p, pr({})).effort).toBeUndefined();
		const bad = project({ automation: { review: true, reviewAgent: { kind: 'codex', effort: 'high' } } });
		expect(reviewBody(bad, pr({})).effort).toBe('high');
	});
});

// A stored session as the cap counter sees it: a review session is a captured PR
// parked on that PR's fetched `pr/<n>` ref.
const session = (branch: string, number: number, status: SessionStatus = 'idle') => ({
	status,
	worktree: { repo: '/p', branch, createdBranch: false },
	pr: { url: '', repo: 'acme/web', number, seenAt: 0 }
});
const reviewSession = (number: number, status?: SessionStatus) => session(`pr/${number}`, number, status);
const workSessionWithPr = (number: number) => session('feature', number);

describe('atReviewCap', () => {
	it('is under the cap with no sessions', () => {
		expect(atReviewCap([])).toBe(false);
	});

	it('is at the cap with one review session in flight', () => {
		expect(atReviewCap([reviewSession(7)])).toBe(true);
	});

	it("doesn't count a work session that captured its own PR", () => {
		expect(atReviewCap([workSessionWithPr(7), workSessionWithPr(8)])).toBe(false);
		expect(atReviewCap([workSessionWithPr(7), reviewSession(8)])).toBe(true);
	});

	it("doesn't let a dead review session hold the slot, since it can never retire", () => {
		expect(atReviewCap([reviewSession(7, 'dead')])).toBe(false);
		expect(atReviewCap([reviewSession(7, 'dead'), reviewSession(8, 'running')])).toBe(true);
	});
});

describe('reviewOrder', () => {
	it('drains oldest-updated first, so a stream of pushes cannot starve an older PR', () => {
		const ordered = reviewOrder(
			[pr({ number: 3, updatedAt: 30 }), pr({ number: 1, updatedAt: 10 }), pr({ number: 2, updatedAt: 20 })],
			(p) => p.updatedAt
		);
		expect(ordered.map((p) => p.number)).toEqual([1, 2, 3]);
	});

	// The real queue is merged across projects, so the timestamp is reached through
	// a wrapper rather than being a field on the item.
	it('orders a merged queue by the timestamp the getter reaches', () => {
		const queue = [
			{ project: 'zeta', pr: pr({ number: 9, updatedAt: 99 }) },
			{ project: 'acme', pr: pr({ number: 1, updatedAt: 1 }) }
		];
		expect(reviewOrder(queue, (q) => q.pr.updatedAt).map((q) => q.project)).toEqual(['acme', 'zeta']);
	});

	it('leaves the input array untouched', () => {
		const input = [pr({ number: 2, updatedAt: 20 }), pr({ number: 1, updatedAt: 10 })];
		reviewOrder(input, (p) => p.updatedAt);
		expect(input.map((p) => p.number)).toEqual([2, 1]);
	});
});

describe('parseAutomation', () => {
	it('collapses the all-default shape to absent', () => {
		expect(parseAutomation({ work: false, review: false })).toBeUndefined();
		expect(parseAutomation({})).toBeUndefined();
	});

	it('keeps a lane that names only a kind, since that is still a pick', () => {
		expect(parseAutomation({ work: false, review: false, workAgent: { kind: 'pi' } })).toMatchObject({
			work: false,
			workAgent: { kind: 'pi' }
		});
	});

	it('carries a stored pick a stale client omits, but clears one it sends blank', () => {
		const stored = { work: true, review: true, reviewAgent: { kind: 'claude' as const, model: 'local' } };
		// The pre-#223 body shape: both toggles, no agent keys at all.
		expect(parseAutomation({ work: true, review: true }, stored)?.reviewAgent?.model).toBe('local');
		expect(parseAutomation({ work: true, review: true, reviewAgent: {} }, stored)?.reviewAgent).toBeUndefined();
	});

	it('keeps an agent pick whose lane is off, so toggling back on does not lose it', () => {
		const parsed = parseAutomation({ work: true, reviewAgent: { kind: 'claude', model: 'local' } });
		expect(parsed).toMatchObject({ work: true, review: false });
		expect(parsed?.reviewAgent?.model).toBe('local');
	});

	it('reads a blank model as unset rather than as a picked empty model', () => {
		expect(parseAutomation({ review: true, reviewAgent: { model: '  ' } })?.reviewAgent).toBeUndefined();
		expect(parseAutomation({ review: true, reviewAgent: { model: ' local ' } })?.reviewAgent?.model).toBe('local');
	});

	it('rejects effort on a non-claude lane, naming the lane', () => {
		expect(() => parseAutomation({ review: true, reviewAgent: { kind: 'pi', effort: 'high' } })).toThrow(
			/reviewAgent: effort is only valid for claude/
		);
	});

	it('rejects a provider on a non-pi lane', () => {
		expect(() => parseAutomation({ work: true, workAgent: { kind: 'codex', provider: 'local' } })).toThrow(
			/workAgent: provider is only valid for pi/
		);
	});

	it('allows effort on a lane with no explicit kind, since that lane is claude', () => {
		expect(parseAutomation({ review: true, reviewAgent: { effort: 'high' } })?.reviewAgent?.effort).toBe('high');
	});

	it('names the field on a top-level shape problem, not just the message', () => {
		expect(() => parseAutomation(null)).toThrow(/^automation: /);
	});

	it('names the accepted values when the kind or effort is not one of them', () => {
		expect(() => parseAutomation({ workAgent: { kind: 'shell' } })).toThrow(/claude/);
		expect(() => parseAutomation({ workAgent: { effort: 'turbo' } })).toThrow(/xhigh/);
	});

	it('rejects a non-object automation body', () => {
		expect(() => parseAutomation([])).toThrow();
		expect(() => parseAutomation({ work: 'yes' })).toThrow();
	});
});
