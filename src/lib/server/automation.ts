// Feed automation (issue #171): the monitor's gh tick auto-spawns a session for
// each new matching feed item on projects that opted in — work (issues assigned
// to me in a todo-ish state) and review (PRs awaiting my review), each toggled
// independently. Idempotence is durable: a given issue/PR fires at most once ever,
// across polls and restarts, tracked in ~/.deck/automation.json. The pure
// key/dedupe logic and request bodies live in automation-core.ts.
import type { Issue, Project, PullRequest } from '$lib/types';
import { listProjects } from './store';
import { getProjectIssues } from './issues';
import { getProjectPrs } from './prs';
import { createSessionFromRequest } from './create-session';
import { notify, type NotifyPayload } from './push';
import { runIdempotent } from './idempotency';
import { readJson, writeJson } from './config';
import {
	reviewBody,
	reviewTriggerKey,
	selectNewTriggers,
	workBody,
	workTriggerKey,
	type NewTrigger,
	type ProcessedKeys
} from './automation-core';

const FILE = 'automation.json';

interface AutomationStore {
	processed: ProcessedKeys;
}

// The durable ledger read/written whole; single-user, low volume, so no caching.
function loadProcessed(): ProcessedKeys {
	return readJson<AutomationStore>(FILE, { processed: {} }).processed ?? {};
}
function persist(processed: ProcessedKeys): void {
	writeJson(FILE, { processed });
}

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
		const { result } = runIdempotent(key, () => createSessionFromRequest(body()));
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
			body: `${candidate.id} · ${candidate.title}`,
			tag: id,
			url: `/s/${id}`
		}));
	}
}

async function runReview(project: Project, processed: ProcessedKeys): Promise<void> {
	const { prs } = await getProjectPrs(project).catch(() => ({ prs: [] as PullRequest[] }));
	for (const { key, candidate } of selectNewTriggers(prs, reviewTriggerKey, processed)) {
		await spawn(processed, key, () => reviewBody(project, candidate), (id) => ({
			title: 'Automation started a review session',
			body: `${candidate.repo}#${candidate.number} · ${candidate.title}`,
			tag: id,
			url: `/s/${id}`
		}));
	}
}

async function runProject(project: Project, processed: ProcessedKeys): Promise<void> {
	const automation = project.automation;
	if (!automation) return;
	if (automation.work) await runWork(project, processed);
	if (automation.review) await runReview(project, processed);
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
		for (const project of listProjects()) {
			await runProject(project, processed);
		}
	} finally {
		polling = false;
	}
}
