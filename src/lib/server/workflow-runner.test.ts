import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeckSession, Project } from '$lib/types';
import type { WorkflowRun } from '$lib/workflows';

// The runner is orchestration: sessions spawn per phase, completions arrive as
// feed events, and pause / take-over / resume / restart must not race them. Drive
// it over a faked session store, feed, git, and gh.
const fake = vi.hoisted(() => ({
	projects: [] as Project[],
	sessions: new Map<string, DeckSession>(),
	created: [] as Record<string, unknown>[],
	lastResult: new Map<string, string>(),
	sent: [] as { id: string; text: string }[],
	interrupted: [] as string[],
	notified: [] as Record<string, unknown>[],
	trees: ['t0'] as string[],
	deltas: [] as [string, string][],
	verifyCode: 0,
	// Whether fetchPullRef freshly fetched pr/<n>, and the PR checkouts the runner refreshed.
	prRefCreated: true,
	synced: [] as [string, number][],
	view: { state: 'OPEN', reviewDecision: null as string | null, reviews: [] as { author: string; state: string }[], headRefOid: 'h', unresolvedThreads: 0 },
	pr: null as null | {
		number: number;
		url: string;
		title: string;
		baseRefName: string;
		closingIssuesReferences: { number: number }[];
	},
	runs: [] as WorkflowRun[],
	// When set, session creation waits on it, to land a control mid-spawn.
	// The branch head and its upstream, for the follow-up fix gate.
	git: { head: 'c0', upstream: 'c0' as string | null },
	spawnGate: null as Promise<void> | null,
	viewGate: null as Promise<void> | null
}));

vi.mock('./agent-feed', async () => {
	const { EventEmitter } = await import('node:events');
	return { agentFeed: new EventEmitter(), publishAgentEvent: () => {} };
});
vi.mock('./config', () => ({ baseUrl: 'http://localhost:4818' }));
vi.mock('./store', () => ({
	listProjects: () => fake.projects,
	getStoredSession: (id: string) => fake.sessions.get(id),
	listStoredSessions: () => [...fake.sessions.values()],
	updateSession: (id: string, patch: Partial<DeckSession>) => Object.assign(fake.sessions.get(id)!, patch)
}));
vi.mock('./sessions', () => ({ deleteSession: async (id: string) => void fake.sessions.delete(id) }));
vi.mock('./create-session', () => ({
	createSessionFromRequest: async (body: Record<string, unknown>) => {
		if (fake.spawnGate) await fake.spawnGate;
		fake.created.push(body);
		const id = `s${fake.created.length}`;
		fake.sessions.set(id, {
			id,
			kind: 'claude',
			title: String(body.title),
			cwd: String(body.cwd),
			createdAt: 0,
			lastActiveAt: 0,
			status: 'running'
		});
		return fake.sessions.get(id);
	}
}));
vi.mock('./agents/dispatch', () => ({
	agentSend: async (s: DeckSession, text: string) => void fake.sent.push({ id: s.id, text }),
	agentInterrupt: (id: string) => void fake.interrupted.push(id),
	agentTurnRunning: () => false
}));
vi.mock('./ask', () => ({ hasPendingAsk: () => false }));
vi.mock('./transcript', () => ({
	sessionLastResult: (id: string) => fake.lastResult.get(id) ?? null
}));
vi.mock('./push', () => ({
	notify: (p: Record<string, unknown>) => void fake.notified.push(p)
}));
vi.mock('./git', () => ({
	createWorktree: async (_repo: string, branch: string) => ({
		dir: `/p/acme-worktrees/${branch}`,
		branch
	}),
	fetchPullRef: async (_repo: string, n: number) => ({
		branch: `pr/${n}`,
		created: fake.prRefCreated
	}),
	originRepo: async () => 'acme/web'
}));
vi.mock('./confine', () => ({
	resolveWithinProjects: (dir: string) => dir,
	projectForPath: () => '/p/acme'
}));
vi.mock('./workflow-exec', () => ({
	snapshotTree: async () => fake.trees.at(-1),
	deltaBetween: async (_cwd: string, from: string, to: string) => {
		fake.deltas.push([from, to]);
		return [`src/hand.ts:L1-3`];
	},
	currentBranch: async () => 'feature',
	headCommit: async () => fake.git.head,
	pushState: async () => ({ branch: 'acme-web-7', upstreamRef: 'origin/acme-web-7', remote: 'origin', clean: true, descends: true, ...fake.git }),
	syncPullWorktree: async (cwd: string, n: number) => void fake.synced.push([cwd, n]),
	toplevel: async (dir: string) => (dir.startsWith('/p/acme/') ? '/p/acme' : dir),
	verifyCommand: () => 'pnpm test',
	runVerify: async () => ({
		code: fake.verifyCode,
		output: fake.verifyCode ? 'FAIL' : 'ok'
	}),
	prForBranch: async () => fake.pr,
	prReviewView: async () => {
		if (fake.viewGate) await fake.viewGate;
		return structuredClone(fake.view);
	},
	ghLogin: async () => 'me'
}));
vi.mock('./workflow-store', async () => {
	const { resolveWorkflows } = await import('./workflow-core');
	return {
		listRuns: () => fake.runs,
		getRun: (id: string) => fake.runs.find((r) => r.id === id),
		saveRun: (run: WorkflowRun) => {
			if (!fake.runs.includes(run)) fake.runs.push(run);
		},
		removeRuns: (ids: string[]) => void (fake.runs = fake.runs.filter((r) => !ids.includes(r.id))),
		loadWorkflows: () => resolveWorkflows({}),
		loadProfiles: () => ({
			acme: {
				githubOwners: ['acme'],
				loopDefault: false,
				reviewer: 'acme-bot'
			}
		})
	};
});
vi.mock('./workflow-overseer', () => ({ noteOverseer: () => {} }));

const { agentFeed } = await import('./agent-feed');
const runner = await import('./workflow-runner');

const settle = async () => {
	for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

// Start a run, land `control` while its first phase session is still spawning,
// then let the spawn finish.
async function midSpawn(control: (run: WorkflowRun) => Promise<unknown>): Promise<WorkflowRun> {
	let release!: () => void;
	fake.spawnGate = new Promise((r) => (release = r));
	const starting = runner.startRun({ cwd: '/p/acme', category: 'dev', issue });
	await settle();
	const run = fake.runs[0];
	await control(run);
	release();
	await starting;
	await settle();
	return run;
}

// The first prompt sent to the n-th created session (0-based; -1 for the last).
const promptOf = (n: number) => {
	const id = `s${n < 0 ? fake.created.length + n + 1 : n + 1}`;
	return fake.sent.find((m) => m.id === id)?.text ?? '';
};
const resumeNotes = () => fake.sent.filter((m) => m.text.includes('deck restarted'));

const findings = (n: number) =>
	'```json\n' +
	JSON.stringify({
		findings: Array.from({ length: n }, (_, i) => ({
			file: `src/${i}.ts`,
			line: 1,
			severity: 'blocker',
			defect: 'd'
		}))
	}) +
	'\n```';

// The current phase's session finishes its turn having said `text`.
async function finishTurn(run: WorkflowRun, text = 'done') {
	const id = run.visits.at(-1)!.sessionId!;
	fake.lastResult.set(id, text);
	(agentFeed as EventEmitter).emit('event', {
		type: 'turn-finished',
		sessionId: id,
		subtype: 'success'
	});
	await settle();
}

const issue = {
	source: 'github' as const,
	id: 'acme/web#7',
	url: 'https://github.com/acme/web/issues/7'
};

async function start(): Promise<WorkflowRun> {
	const run = await runner.startRun({ cwd: '/p/acme', category: 'dev', issue });
	await settle();
	return run;
}

beforeEach(() => {
	fake.projects = [{ name: 'acme', path: '/p/acme' }];
	fake.sessions.clear();
	fake.created = [];
	fake.lastResult.clear();
	fake.sent = [];
	fake.interrupted = [];
	fake.notified = [];
	fake.trees = ['t0'];
	fake.deltas = [];
	fake.verifyCode = 0;
	fake.prRefCreated = true;
	fake.synced = [];
	fake.spawnGate = null;
	fake.git = { head: 'c0', upstream: 'c0' };
	fake.viewGate = null;
	fake.view = { state: 'OPEN', reviewDecision: null, reviews: [], headRefOid: 'h', unresolvedThreads: 0 };
	fake.pr = {
		number: 9,
		url: 'https://github.com/acme/web/pull/9',
		title: 'x',
		baseRefName: 'main',
		closingIssuesReferences: [{ number: 7 }]
	};
	fake.runs = [];
});

describe('a dev run end to end', () => {
	it('runs each phase in a fresh session in the issue worktree and ends with a linked PR', async () => {
		const run = await start();
		expect(run.cwd).toBe('/p/acme-worktrees/acme-web-7');
		expect(fake.created[0]).toMatchObject({
			cwd: run.cwd,
			title: '#7 · Implement',
			kind: 'claude'
		});
		expect(promptOf(0)).toMatch(/^\/dev-workflow /);
		// Every phase shares the worktree without owning it.
		expect(fake.sessions.get('s1')?.worktree).toEqual({
			repo: '/p/acme',
			branch: 'acme-web-7',
			createdBranch: false,
			base: undefined
		});

		await finishTurn(run); // implement -> verify (exit 0) -> review
		expect(run.phase).toBe('review');
		expect(promptOf(1)).toMatch(/^\/dev-review/);

		await finishTurn(run, findings(0)); // clean -> pr
		expect(run.phase).toBe('pr');
		await finishTurn(run); // linked PR; the profile's loop is off -> done
		expect(run.status).toBe('done');
		expect(run.pr?.number).toBe(9);
		expect(fake.created).toHaveLength(3);
		expect(fake.notified.at(-1)).toMatchObject({
			reason: 'stopped',
			url: `/runs/${run.id}`
		});
	});

	it('retries a PR that does not close the issue, then blocks and notifies', async () => {
		fake.pr!.closingIssuesReferences = [];
		const run = await start();
		await finishTurn(run);
		await finishTurn(run, findings(0));
		await finishTurn(run);
		expect(run.phase).toBe('pr');
		expect(run.visits.filter((v) => v.step === 'pr')).toHaveLength(2);
		await finishTurn(run);
		expect(run.status).toBe('blocked');
		expect(run.block?.question).toContain('does not close #7');
		expect(fake.notified.at(-1)).toMatchObject({
			reason: 'needs-you',
			ask: { runId: run.id, header: run.title, options: [], questions: 1 }
		});
	});

	it('blocks a review that ends without its findings block after one retry', async () => {
		const run = await start();
		await finishTurn(run);
		await finishTurn(run, 'looks fine to me');
		expect(run.phase).toBe('review');
		await finishTurn(run, 'still prose');
		expect(run.status).toBe('blocked');
	});
});

describe('one run per worktree', () => {
	it('refuses a second run in a worktree that has an active one', async () => {
		await start();
		await expect(runner.startRun({ cwd: '/p/acme', category: 'dev', issue })).rejects.toMatchObject({ status: 409 });
	});

	it('runs two issues of the same repo side by side', async () => {
		await start();
		const other = await runner.startRun({
			cwd: '/p/acme',
			category: 'dev',
			issue: { ...issue, id: 'acme/web#8' }
		});
		expect(other.status).toBe('running');
		expect(fake.runs).toHaveLength(2);
	});
});

describe('take over and resume', () => {
	it('pauses, stops the turn, ignores the session finishing, and reviews the hand edits on resume', async () => {
		const run = await start();
		await finishTurn(run);
		await finishTurn(run, findings(1)); // round 1: one blocker -> fix
		expect(run.phase).toBe('fix');
		const fixSession = run.visits.at(-1)!.sessionId!;

		await runner.runAction(run.id, 'takeover', { reason: 'I know this one' });
		expect(run.status).toBe('paused');
		expect(fake.interrupted).toEqual([fixSession]);
		expect(run.visits.at(-1)?.humanTouched).toBe(true);

		// You drive the session; its turn ending must not move the run.
		await finishTurn(run);
		expect(run.phase).toBe('fix');
		expect(run.status).toBe('paused');

		// Hand edits change the tree; resuming at review scopes the round to them.
		fake.trees.push('t-hand');
		await runner.runAction(run.id, 'resume', { phase: 'review' });
		await settle();
		expect(run.phase).toBe('review');
		expect(fake.deltas).toEqual([['t0', 't-hand']]);
		expect(promptOf(-1)).toContain('src/hand.ts:L1-3');
		expect(run.decisions.map((d) => d.action)).toEqual(expect.arrayContaining(['pause', 'takeover', 'resume']));
	});

	it('holds a turn that ends during a pause and settles it on resume instead of re-running', async () => {
		const run = await start();
		await runner.runAction(run.id, 'pause', {});
		await finishTurn(run);
		expect(run.phase).toBe('implement');
		expect(run.visits[0].endedAt).toBeUndefined();
		await runner.runAction(run.id, 'resume', {});
		await settle();
		expect(run.visits[0].result).toBe('pass');
		expect(run.phase).toBe('review');
		expect(fake.created.filter((b) => String(b.title).includes('Implement'))).toHaveLength(1);
	});

	// Retry always starts over; resume after a take-over too, since those turns were yours.
	it.each([
		['pause', 'retry'],
		['takeover', 'resume']
	])('re-runs the phase after %s then %s, even though its turn ended', async (stop, go) => {
		const run = await start();
		await runner.runAction(run.id, stop as 'pause', {});
		await finishTurn(run);
		await runner.runAction(run.id, go as 'retry', {});
		await settle();
		expect(run.phase).toBe('implement');
		expect(run.visits.map((v) => v.result)).toEqual(['interrupted', undefined]);
	});

	it('refuses to pause a blocked run, which would hide its question', async () => {
		const run = await start();
		await runner.runAction(run.id, 'block', { question: 'Which?' });
		await expect(runner.runAction(run.id, 'pause', {})).rejects.toMatchObject({ status: 409 });
	});

	it('applies a completion once when the turn event and the settle poll race', async () => {
		const run = await start();
		fake.lastResult.set('s1', 'done');
		const event = { type: 'turn-finished', sessionId: 's1', subtype: 'success' };
		(agentFeed as EventEmitter).emit('event', event);
		(agentFeed as EventEmitter).emit('event', event);
		await settle();
		expect(run.visits.filter((v) => v.step === 'verify')).toHaveLength(1);
		expect(run.visits.filter((v) => v.step === 'review')).toHaveLength(1);
	});

	it('never starts a phase session that a pause landed on mid-spawn', async () => {
		const run = await midSpawn((r) => runner.runAction(r.id, 'pause', {}));
		expect(fake.created).toHaveLength(1);
		expect(fake.sent).toEqual([]);
		expect(fake.sessions.has('s1')).toBe(false);
		expect(run.visits[0].sessionId).toBeUndefined();
	});

	it('cancels for good, stopping the phase session', async () => {
		const run = await start();
		await runner.runAction(run.id, 'cancel', {});
		expect(run.status).toBe('cancelled');
		expect(fake.interrupted).toEqual(['s1']);
		await finishTurn(run);
		expect(run.phase).toBe('implement');
		await expect(runner.runAction(run.id, 'resume', {})).rejects.toMatchObject({ status: 409 });
	});

	it('answers a blocked run and resumes it with the answer in the prompt', async () => {
		const run = await start();
		await runner.runAction(run.id, 'block', {
			question: 'Which API version?',
			by: 'overseer',
			reason: 'the issue is ambiguous'
		});
		expect(run.status).toBe('blocked');
		expect(run.decisions.at(-1)).toMatchObject({
			by: 'overseer',
			action: 'block',
			reason: 'the issue is ambiguous'
		});
		expect(runner.blockedRunForSession('s1')).toBe(run);

		await runner.runAction(run.id, 'answer', { text: 'v2' });
		await settle();
		expect(run.status).toBe('running');
		expect(promptOf(-1)).toContain('- v2');
	});

	it('messages only a paused phase session', async () => {
		const run = await start();
		await expect(runner.runAction(run.id, 'message', { text: 'use v2' })).rejects.toMatchObject({ status: 409 });
		await runner.runAction(run.id, 'pause', {});
		await runner.runAction(run.id, 'message', { text: 'use v2' });
		expect(fake.sent.at(-1)).toEqual({ id: 's1', text: 'use v2' });
	});

	it('refuses to message a review phase', async () => {
		const run = await start();
		await finishTurn(run);
		expect(run.phase).toBe('review');
		await expect(runner.runAction(run.id, 'message', { text: 'focus on auth' })).rejects.toMatchObject({ status: 409 });
	});
});

describe('restart recovery', () => {
	it('tells a phase session that was mid-turn to carry on', async () => {
		const run = await start();
		runner.recoverRuns();
		await settle();
		expect(resumeNotes()).toEqual([{ id: 's1', text: expect.stringContaining('deck restarted') }]);
		expect(run.decisions.at(-1)).toMatchObject({
			by: 'engine',
			action: 'recover'
		});
	});

	it('starts an interrupted review round over in a fresh session, keeping its baseline', async () => {
		const run = await start();
		await finishTurn(run);
		await finishTurn(run, findings(1)); // round 1 done at t0 -> fix
		await finishTurn(run); // fix -> verify -> review round 2
		fake.trees.push('t1');
		expect(run.phase).toBe('review');
		const before = fake.created.length;
		runner.recoverRuns();
		await settle();
		expect(resumeNotes()).toEqual([]);
		expect(fake.created).toHaveLength(before + 1);
		expect(fake.deltas.at(-1)).toEqual(['t0', 't1']);
	});

	it('starts the phase again when its session is gone', async () => {
		const run = await start();
		fake.sessions.delete('s1');
		runner.recoverRuns();
		await settle();
		expect(run.visits[0]).toMatchObject({ result: 'interrupted' });
		expect(run.visits[1].sessionId).toBe('s2');
	});
});

describe('controls never leave two agents in one worktree', () => {
	it('stops the running phase session on resume and retry', async () => {
		const run = await start();
		await runner.runAction(run.id, 'retry', {});
		await settle();
		expect(fake.interrupted).toEqual(['s1']);
		expect(run.visits.map((v) => v.sessionId)).toEqual(['s1', 's2']);
	});

	it('gives a red-verify block a real fresh start when answered', async () => {
		fake.verifyCode = 1;
		const run = await start();
		await finishTurn(run); // implement -> verify red -> fix
		await finishTurn(run); // -> verify red -> fix
		await finishTurn(run); // -> verify red: blocked
		expect(run.status).toBe('blocked');
		await runner.runAction(run.id, 'answer', { text: 'try once more' });
		await settle();
		// Still red, but counted from zero again: back to fix, not straight to blocked.
		expect(run.status).toBe('running');
		expect(run.phase).toBe('fix');
	});
});

// A run with the post-PR loop on, walked to its PR: entering the reviewer loop.
async function toFeedback(): Promise<WorkflowRun> {
	const run = await runner.startRun({ cwd: '/p/acme', category: 'dev', issue });
	run.loop = true;
	await settle();
	await finishTurn(run);
	await finishTurn(run, findings(0));
	await finishTurn(run); // PR linked -> feedback, waiting on the reviewer
	return run;
}

describe('the reviewer loop', () => {

	it('waits, runs a round on new activity, waits again, and ends on approval', async () => {
		const run = await toFeedback();
		expect(run.status).toBe('waiting');
		const sessions = fake.created.length;

		await runner.pollRuns();
		expect(fake.created).toHaveLength(sessions);

		fake.view.reviews = [{ author: 'bot', state: 'CHANGES_REQUESTED' }];
		fake.view.unresolvedThreads = 2;
		// Two polls racing (the enter path and a tick) start one round, not two.
		await Promise.all([runner.pollRuns(), runner.runAction(run.id, 'note', {}).then(() => runner.pollRuns())]);
		await settle();
		expect(fake.created).toHaveLength(sessions + 1);
		expect(promptOf(-1)).toMatch(/^\/address-feedback/);

		fake.view.unresolvedThreads = 0;
		await finishTurn(run);
		expect(run.status).toBe('waiting');
		await runner.pollRuns();
		expect(fake.created).toHaveLength(sessions + 1);

		fake.view.reviews.push({ author: 'bot', state: 'APPROVED' });
		await runner.pollRuns();
		await settle();
		expect(run.status).toBe('done');
	});
});

describe('the reviewer loop race', () => {
	it('starts one round when entering the loop and a monitor tick see new activity together', async () => {
		let release!: () => void;
		fake.viewGate = new Promise((r) => (release = r));
		fake.view.reviews = [{ author: 'bot', state: 'CHANGES_REQUESTED' }];
		await toFeedback(); // its first poll is held at the gate
		const sessions = fake.created.length;
		const tick = runner.pollRuns(); // a monitor tick, also held at the gate
		release();
		await tick;
		await settle();
		expect(fake.created).toHaveLength(sessions + 1);
	});
});

describe('the settle safety net', () => {
	it('settles a phase whose turn-finished event never arrived', async () => {
		const run = await start();
		run.visits[0].startedAt -= 10 * 60_000;
		fake.sessions.get('s1')!.status = 'idle';
		fake.lastResult.set('s1', 'done');
		await runner.pollRuns();
		await settle();
		expect(run.visits[0].result).toBe('pass');
		expect(run.phase).toBe('review');
	});

	it('leaves a phase alone inside its grace period', async () => {
		const run = await start();
		fake.sessions.get('s1')!.status = 'idle';
		await runner.pollRuns();
		expect(run.visits[0].endedAt).toBeUndefined();
	});
});

describe('where a run starts', () => {
	it('gives a run started in a subdirectory of the main checkout its own worktree', async () => {
		const run = await runner.startRun({ cwd: '/p/acme/apps/web', category: 'dev', issue });
		expect(run.cwd).toBe('/p/acme-worktrees/acme-web-7');
	});

	it('works in place when started inside a worktree', async () => {
		const run = await runner.startRun({ cwd: '/p/acme-worktrees/feature', category: 'dev', issue });
		expect(run).toMatchObject({ cwd: '/p/acme-worktrees/feature', branch: 'feature' });
	});

	it('refuses a review run started inside a worktree', async () => {
		await expect(
			runner.startRun({ cwd: '/p/acme-worktrees/feature', category: 'review', pr: { repo: 'acme/web', number: 5 } })
		).rejects.toMatchObject({ status: 400 });
	});

	const reviewPr5 = () => runner.startRun({ cwd: '/p/acme', category: 'review', pr: { repo: 'acme/web', number: 5 } });

	it('leaves a freshly fetched PR checkout alone', async () => {
		const run = await reviewPr5();
		expect(run.cwd).toBe('/p/acme-worktrees/pr/5');
		expect(fake.synced).toEqual([]);
	});

	it('moves an existing PR checkout to the PR head before reviewing it again', async () => {
		fake.prRefCreated = false;
		const run = await reviewPr5();
		expect(run.cwd).toBe('/p/acme-worktrees/pr/5');
		expect(fake.synced).toEqual([['/p/acme-worktrees/pr/5', 5]]);
	});

	it('refuses to move a PR checkout a plain review session is working in', async () => {
		fake.prRefCreated = false;
		fake.sessions.set('plain', { id: 'plain', kind: 'claude', title: 'review', cwd: '/p/acme-worktrees/pr/5', createdAt: 0, lastActiveAt: 0, status: 'running' });
		await expect(reviewPr5()).rejects.toMatchObject({ status: 409 });
		expect(fake.synced).toEqual([]);
	});

	it('refreshes a PR checkout under a finished plain review session', async () => {
		fake.prRefCreated = false;
		fake.sessions.set('plain', { id: 'plain', kind: 'claude', title: 'review', cwd: '/p/acme-worktrees/pr/5', createdAt: 0, lastActiveAt: 0, status: 'idle' });
		await reviewPr5();
		expect(fake.synced).toEqual([['/p/acme-worktrees/pr/5', 5]]);
	});

	it('refreshes past the idle sessions an earlier run left in the checkout, but not under a live run', async () => {
		const first = await reviewPr5();
		await settle();
		fake.prRefCreated = false;
		await expect(reviewPr5()).rejects.toMatchObject({ status: 409 });
		expect(fake.synced).toEqual([]);
		await runner.runAction(first.id, 'cancel', {});
		const again = await reviewPr5();
		expect(again.cwd).toBe('/p/acme-worktrees/pr/5');
		expect(fake.synced).toEqual([['/p/acme-worktrees/pr/5', 5]]);
	});

	it('refuses a workflow that does not fit what it was started from', async () => {
		await expect(runner.startRun({ cwd: '/p/acme', workflow: 'review', issue })).rejects.toMatchObject({ status: 400 });
		await expect(runner.startRun({ cwd: '/p/acme', workflow: 'dev', pr: { repo: 'acme/web', number: 5 } })).rejects.toMatchObject({ status: 400 });
	});

	it('picks the review workflow for a PR when no category is named', async () => {
		const run = await runner.startRun({ cwd: '/p/acme', pr: { repo: 'acme/web', number: 5 } });
		expect(run.category).toBe('review');
	});

	it('refuses a PR from another repo than the project', async () => {
		await expect(runner.startRun({ cwd: '/p/acme', category: 'review', pr: { repo: 'other/app', number: 5 } })).rejects.toMatchObject({
			status: 400
		});
	});
});

describe('deleting a run', () => {
	it('stops a live run, removes it, and ignores its phase session afterwards', async () => {
		const run = await start();
		runner.deleteRun(run.id);
		expect(fake.runs).toEqual([]);
		expect(fake.interrupted).toEqual(['s1']);
		await finishTurn(run);
		expect(fake.created).toHaveLength(1);
		expect(fake.sessions.has('s1')).toBe(true);
	});

	it('drops a phase session that was still spawning when the run was deleted', async () => {
		await midSpawn(async (r) => runner.deleteRun(r.id));
		expect(fake.sent).toEqual([]);
		expect(fake.sessions.size).toBe(0);
	});

	it('leaves a taken-over session running for you', async () => {
		const run = await start();
		await runner.runAction(run.id, 'takeover', {});
		fake.interrupted = [];
		runner.deleteRun(run.id);
		expect(fake.interrupted).toEqual([]);
		expect(fake.runs).toEqual([]);
	});

	it('clears only finished runs', async () => {
		const live = await start();
		const done = await runner.startRun({ cwd: '/p/acme', category: 'dev', issue: { ...issue, id: 'acme/web#8' } });
		const cancelled = await runner.startRun({ cwd: '/p/acme', category: 'dev', issue: { ...issue, id: 'acme/web#9' } });
		done.status = 'done';
		await runner.runAction(cancelled.id, 'cancel', {});
		fake.interrupted = [];
		expect(runner.clearFinishedRuns()).toBe(2);
		expect(fake.runs).toEqual([live]);
		expect(fake.interrupted).toEqual([]);
		expect(runner.clearFinishedRuns()).toBe(0);
	});

	it('404s an unknown run', () => {
		expect(() => runner.deleteRun('r_nope')).toThrow(expect.objectContaining({ status: 404 }));
	});
});

describe('fixing leftover findings', () => {
	const nit = '```json\n{"findings":[{"file":"src/push.ts","line":9,"severity":"nit","defect":"a failed post is dropped","fix":"log it","keep":"the background path"}]}\n```';

	// A dev run whose review passed with one nit, through to its PR: done.
	async function doneWithNit(): Promise<WorkflowRun> {
		const run = await start();
		await finishTurn(run);
		await finishTurn(run, nit);
		await finishTurn(run);
		expect(run).toMatchObject({ status: 'done', findings: [{ severity: 'nit' }] });
		return run;
	}

	it('runs one fix session over the findings and finishes once git shows a pushed commit', async () => {
		const run = await doneWithNit();
		await runner.runAction(run.id, 'fix-findings', {});
		expect(run).toMatchObject({ status: 'running', phase: 'fix', followUp: { head: 'c0' } });
		expect(promptOf(-1)).toContain('src/push.ts');
		expect(promptOf(-1)).toContain('push it to the PR branch');

		fake.git = { head: 'c1', upstream: 'c1' };
		await finishTurn(run);
		expect(run).toMatchObject({ status: 'done', phase: 'fix', findings: [] });
		expect(run.followUp).toBeUndefined();
		expect(run.visits.filter((v) => v.step === 'verify')).toHaveLength(1);
	});

	it.each([
		['no new commit', { head: 'c0', upstream: 'c0' }],
		['the new commit is not pushed', { head: 'c1', upstream: 'c0' }],
		['exited 1 on the pushed commit', { head: 'c1', upstream: 'c1', verify: 1 }]
	])('blocks when there is %s', async (detail, git) => {
		const run = await doneWithNit();
		await runner.runAction(run.id, 'fix-findings', {});
		fake.git = { head: git.head, upstream: git.upstream };
		fake.verifyCode = 'verify' in git ? git.verify : 0;
		await finishTurn(run);
		expect(run.status).toBe('blocked');
		expect(run.block?.question).toContain(detail);
		expect(run.findings).toHaveLength(1);
	});

	it('reopens once when two requests race', async () => {
		const run = await doneWithNit();
		const [a, b] = await Promise.allSettled([runner.runAction(run.id, 'fix-findings', {}), runner.runAction(run.id, 'fix-findings', {})]);
		expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
		await settle();
		expect(fake.created.filter((c) => String(c.title).includes('Fix'))).toHaveLength(1);
	});

	it('keeps the run done while its PR is checked, and reopens nothing once deleted', async () => {
		const run = await doneWithNit();
		let release!: () => void;
		fake.viewGate = new Promise((r) => (release = r));
		const reopening = runner.runAction(run.id, 'fix-findings', {});
		await settle();
		await expect(runner.runAction(run.id, 'pause', {})).rejects.toMatchObject({ status: 409 });
		await expect(runner.runAction(run.id, 'cancel', {})).rejects.toMatchObject({ status: 409 });
		expect(run.status).toBe('done');
		runner.deleteRun(run.id);
		release();
		await reopening;
		await settle();
		expect(run.status).toBe('done');
		expect(fake.created.filter((c) => String(c.title).includes('Fix'))).toHaveLength(0);
	});

	it('stays done when the PR is no longer open', async () => {
		const merged = await doneWithNit();
		fake.view.state = 'MERGED';
		await expect(runner.runAction(merged.id, 'fix-findings', {})).rejects.toMatchObject({ status: 409 });
		expect(merged.status).toBe('done');
	});

	it('drops the follow-up when resumed at another phase, so a later fix round is normal', async () => {
		const run = await doneWithNit();
		await runner.runAction(run.id, 'fix-findings', {});
		await finishTurn(run); // no new commit: blocked
		await runner.runAction(run.id, 'resume', { phase: 'verify' });
		expect(run.followUp).toBeUndefined();
	});

	it('refuses a run that is not a finished dev run with leftover findings', async () => {
		const run = await start();
		await expect(runner.runAction(run.id, 'fix-findings', {})).rejects.toMatchObject({ status: 409 });
	});
});
