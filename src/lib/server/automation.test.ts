import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { DeckSession, Project, PullRequest } from '$lib/types';

// The review drain (issue #224) is orchestration, not pure logic: the cap has to
// be checked before `spawn` claims the trigger key, the tick has to stop rather
// than skip past a capped candidate, and the order has to be global. None of that
// shows up in the automation-core unit tests, so drive pollAutomation over a
// faked store and feed.
const fake = vi.hoisted(() => ({
	projects: [] as Project[],
	sessions: [] as DeckSession[],
	prs: {} as Record<string, PullRequest[]>,
	processed: {} as Record<string, number>,
	created: [] as Record<string, unknown>[],
	options: [] as (Record<string, unknown> | undefined)[]
}));

vi.mock('./store', () => ({
	listProjects: () => fake.projects,
	listStoredSessions: () => fake.sessions
}));
vi.mock('./issues', () => ({ getProjectIssues: async () => ({ issues: [] }) }));
vi.mock('./prs', () => ({ getProjectPrs: async (p: Project) => ({ prs: fake.prs[p.path] ?? [] }) }));
vi.mock('./push', () => ({ notify: () => {} }));
vi.mock('./idempotency', () => ({ runIdempotent: (_k: string, run: () => unknown) => ({ result: run() }) }));
vi.mock('./automation-ledger', () => ({
	loadProcessed: () => fake.processed,
	persist: (p: Record<string, number>) => {
		fake.processed = p;
	}
}));
// Every create lands a review session in the store, which is what makes the next
// candidate's recount see the cap.
vi.mock('./create-session', () => ({
	createSessionFromRequest: async (body: Record<string, unknown>, opts?: Record<string, unknown>) => {
		fake.created.push(body);
		fake.options.push(opts);
		const pr = body.pr as { number: number };
		fake.sessions.push(reviewSession(pr.number));
		return { id: `s${fake.created.length}` };
	}
}));

const { pollAutomation } = await import('./automation');

const project = (name: string): Project => ({
	name,
	path: `/p/${name}`,
	automation: { review: true }
});

const pr = (number: number, updatedAt: number): PullRequest => ({
	sourceId: 's1',
	repo: 'acme/web',
	number,
	title: `pr ${number}`,
	url: 'https://example.com',
	headRefName: 'h',
	headRefOid: `sha${number}`,
	baseRefName: 'main',
	isDraft: false,
	author: 'someone',
	updatedAt
});

function session(branch: string, number: number, status: DeckSession['status'] = 'idle'): DeckSession {
	return {
		id: `existing-${number}`,
		kind: 'claude',
		title: 't',
		cwd: '/p',
		createdAt: 0,
		lastActiveAt: 0,
		status,
		worktree: { repo: '/p', branch, createdBranch: false },
		pr: { url: '', repo: 'acme/web', number, seenAt: 0 }
	};
}
const reviewSession = (number: number, status?: DeckSession['status']) =>
	session(`pr/${number}`, number, status);

const spawnedNumbers = () => fake.created.map((b) => (b.pr as { number: number }).number);

describe('automatic review throttle', () => {
	beforeEach(() => {
		fake.projects = [project('acme')];
		fake.sessions = [];
		fake.prs = { '/p/acme': [pr(1, 100), pr(2, 200), pr(3, 300)] };
		fake.processed = {};
		fake.created = [];
		fake.options = [];
	});

	it('spawns one review for three eligible PRs and leaves the rest unclaimed', async () => {
		await pollAutomation();
		expect(fake.created).toHaveLength(1);
		// Unclaimed, so the next tick retries them.
		expect(Object.keys(fake.processed)).toEqual(['auto:review:acme/web#1@sha1']);
	});

	it('drains oldest-updated first, across projects and not just within one', async () => {
		fake.projects = [project('acme'), project('zeta')];
		fake.prs = { '/p/acme': [pr(3, 300)], '/p/zeta': [pr(9, 50)] };
		await pollAutomation();
		expect(spawnedNumbers()).toEqual([9]);

		// The next tick picks up what the cap skipped, once the slot is free.
		fake.sessions = [];
		fake.created = [];
		fake.prs['/p/zeta'] = [];
		await pollAutomation();
		expect(spawnedNumbers()).toEqual([3]);
	});

	it('spawns nothing while a review session is already in flight', async () => {
		fake.sessions = [reviewSession(99)];
		await pollAutomation();
		expect(fake.created).toEqual([]);
		expect(fake.processed).toEqual({});
	});

	it('holds the slot for a review session mid-turn, not just an idle one', async () => {
		fake.sessions = [reviewSession(99, 'running')];
		await pollAutomation();
		expect(fake.created).toEqual([]);
	});

	// An automatic session reads the remembered pick as its default, so writing it
	// back would make the manual picker default to whatever automation last ran.
	it("doesn't let an automatic session overwrite the project's remembered pick", async () => {
		await pollAutomation();
		expect(fake.options[0]).toEqual({ remember: false });
	});

	it("doesn't let a work session that captured its own PR hold the slot", async () => {
		fake.sessions = [session('feature', 42)];
		await pollAutomation();
		expect(fake.created).toHaveLength(1);
	});

	it("doesn't let a stuck review session hold the slot, since it can never retire", async () => {
		fake.sessions = [reviewSession(99, 'error')];
		await pollAutomation();
		expect(fake.created).toHaveLength(1);
	});

	it('skips a PR already claimed in the ledger, so a restart mid-queue re-spawns nothing', async () => {
		fake.processed = { 'auto:review:acme/web#1@sha1': 1 };
		await pollAutomation();
		expect(spawnedNumbers()).toEqual([2]);
	});

	it('spawns nothing for a project that never opted in', async () => {
		fake.projects = [{ name: 'acme', path: '/p/acme' }];
		await pollAutomation();
		expect(fake.created).toEqual([]);
	});

	it('carries the project automation agent config into the create body', async () => {
		fake.projects = [
			{
				...project('acme'),
				lastEffort: 'high',
				automation: { review: true, reviewAgent: { kind: 'claude', model: 'local-profile' } }
			}
		];
		await pollAutomation();
		expect(fake.created[0]).toMatchObject({ kind: 'claude', model: 'local-profile', effort: 'high' });
	});
});
