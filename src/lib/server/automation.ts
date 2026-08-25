// Feed automation (issue #171): the monitor's gh tick auto-spawns a session for
// each new matching feed item on projects that opted in — work (issues assigned
// to me in a todo-ish state) and review (PRs awaiting my review), each toggled
// independently. Idempotence is durable: a given issue/PR fires at most once ever,
// across polls and restarts, tracked in ~/.deck/automation.json. The pure
// key/dedupe logic and request bodies live in automation-core.ts.
import { shortIssueId } from '$lib/issues';
import type { Issue, Project, PullRequest } from '$lib/types';
import { listProjects, listStoredSessions } from './store';
import { getProjectIssues } from './issues';
import { getProjectPrs } from './prs';
import { createSessionFromRequest } from './create-session';
import { notify, type NotifyPayload } from './push';
import { runIdempotent } from './idempotency';
import { loadProcessed, persist } from './automation-ledger';
import {
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
	type NewTrigger,
	type ProcessedKeys
} from './automation-core';

// Claim the key durably before creating, so a crash mid-create can't respawn the
// item on the next poll. On a caught failure (transient gh/worktree error) release
// the claim so a later tick retries; an uncaught crash leaves it claimed (safe: no
// duplicate). runIdempotent is a second, in-process guard against an overlapping
// tick racing the same key within its window.
async function spawn(
	processed: ProcessedKeys,
	key: string,
	body: () => Record<string, unknown>,
	describe: (sessionId: string) => NotifyPayload
): Promise<void> {
	processed[key] = Date.now();
	persist(processed);
	let session: Awaited<ReturnType<typeof createSessionFromRequest>>;
	try {
		const { result } = runIdempotent(key, () =>
			createSessionFromRequest(body(), { remember: false })
		);
		session = await result;
	} catch (e) {
		delete processed[key];
		persist(processed);
		console.error(`[deck] automation spawn failed for ${key}:`, e);
		return;
	}
	// The session exists now, so the claim stays put even if notify fails —
	// releasing it would let the next poll respawn, breaking at-most-once.
	try {
		notify(describe(session.id));
	} catch (e) {
		console.error(`[deck] automation notification failed for ${key}:`, e);
	}
}

async function runWork(project: Project, processed: ProcessedKeys): Promise<void> {
	const { issues } = await getProjectIssues(project).catch(() => ({ issues: [] as Issue[] }));
	for (const { key, candidate } of selectNewTriggers(issues, workTriggerKey, processed)) {
		await spawn(processed, key, () => workBody(project, candidate), (id) => ({
			title: 'Automation started a work session',
			body: `${shortIssueId(candidate.sourceType, candidate.id)} · ${candidate.title}`,
			tag: id,
			url: `/s/${id}`
		}));
	}
}

// PRs a session has already captured, so a review still in flight doesn't spawn a
// second session on every push (the PR stays in `review-requested:@me` until you
// review it). Retiring a finished review session (see pr.ts) is what clears this.
function sessionPrIdentities(): Set<string> {
	const out = new Set<string>();
	for (const s of listStoredSessions()) if (s.pr) out.add(prIdentity(s.pr));
	return out;
}

// One project's review candidates: PRs no session has already captured, minus the
// trigger keys that already fired. Unordered here; the queue is ordered once it's
// merged across projects.
function reviewCandidates(prs: PullRequest[], processed: ProcessedKeys): NewTrigger<PullRequest>[] {
	if (migrateReviewKeys(prs, processed)) persist(processed);
	const open = sessionPrIdentities();
	return selectNewTriggers(prs.filter((pr) => !open.has(prIdentity(pr))), reviewTriggerKey, processed);
}

async function spawnReview(
	project: Project,
	processed: ProcessedKeys,
	{ key, candidate }: NewTrigger<PullRequest>
): Promise<void> {
	if (pruneSupersededReviewKeys(processed, candidate)) persist(processed);
	await spawn(processed, key, () => reviewBody(project, candidate), (id) => ({
		title: 'Automation started a review session',
		body: `${candidate.repo}#${candidate.number} · ${candidate.title}`,
		tag: id,
		url: `/s/${id}`
	}));
}

// One project's candidate paired with the project it came from, so the merged
// queue can still build the right create body.
interface QueuedReview {
	project: Project;
	trigger: NewTrigger<PullRequest>;
}

// Every review-enabled project's candidates, in one queue.
async function reviewQueue(projects: Project[], processed: ProcessedKeys): Promise<QueuedReview[]> {
	const queue: QueuedReview[] = [];
	for (const project of projects) {
		const { prs } = await getProjectPrs(project).catch(() => ({ prs: [] as PullRequest[] }));
		for (const trigger of reviewCandidates(prs, processed)) queue.push({ project, trigger });
	}
	return queue;
}

// Drain the queue under the cap. Both the cap and the order are global: ordering
// inside a project would let whichever project sorts first take the single slot
// every tick while an older PR elsewhere waits forever, which is the starvation
// the ordering exists to prevent.
async function runReviews(projects: Project[], processed: ProcessedKeys): Promise<void> {
	// Cheap pre-check: at the cap the gh fan-out below buys nothing, and under a
	// cap of one that's the common case while a review is in flight.
	if (atReviewCap(listStoredSessions())) return;
	const queue = await reviewQueue(projects, processed);
	for (const { project, trigger } of reviewOrder(queue, (q) => q.trigger.candidate.updatedAt)) {
		// Recounted per candidate, and before the key is claimed: spawn persists
		// `processed[key]` up front, so skipping any later would mark the PR
		// processed and never review it. Leaving it unclaimed means the next tick
		// retries.
		if (atReviewCap(listStoredSessions())) return;
		await spawnReview(project, processed, trigger);
	}
}

async function runWorks(projects: Project[], processed: ProcessedKeys): Promise<void> {
	for (const project of projects) await runWork(project, processed);
}

// The projects that opted into one automation lane.
function enabled(projects: Project[], lane: 'work' | 'review'): Project[] {
	return projects.filter((p) => p.automation?.[lane]);
}

// Re-entrancy guard mirroring monitor.ts / syncCapturedPrs: a slow gh fan-out
// mustn't let the next tick start an overlapping poll that races the ledger.
let polling = false;

// One automation pass over every opted-in project. Best-effort and self-guarded;
// hung on the monitor's gh tick. Projects with no sources/repo yield empty feeds
// and spawn nothing.
export async function pollAutomation(): Promise<void> {
	if (polling) return;
	polling = true;
	try {
		const processed = loadProcessed();
		const projects = listProjects();
		await runWorks(enabled(projects, 'work'), processed);
		await runReviews(enabled(projects, 'review'), processed);
	} finally {
		polling = false;
	}
}
