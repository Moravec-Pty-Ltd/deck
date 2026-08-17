// Pure trigger-key + dedupe logic and the /api/sessions request bodies for feed
// automation (issue #171), kept node-free so they unit-test without fs/gh. The
// orchestration (feed fetch, session create, notify, durable ledger) lives in the
// sibling automation.ts.
import { shortIssueId } from '$lib/issues';
import type { Issue, Project, PullRequest } from '$lib/types';

// The durable ledger of trigger keys that have already spawned a session, keyed
// to their first-fired timestamp. An item lingering in a feed across polls and
// restarts is matched against this, so it never spawns twice.
export type ProcessedKeys = Record<string, number>;

// Deterministic per-issue key: source type + the issue's globally-unique id
// (owner/repo#n, LIN-123, #abc). Keyed by type, not source id, so re-adding a
// source doesn't resurrect already-processed issues.
export function workTriggerKey(issue: Pick<Issue, 'sourceType' | 'id'>): string {
	return `auto:work:${issue.sourceType}:${issue.id}`;
}

// Deterministic per-PR key, pinned to the head sha: a re-requested review comes
// back into the feed at a new head, and that must fire again (issue #209). The
// PR-only form below is the pre-#209 key shape, kept for migration and pruning.
function reviewKeyPrefix(pr: Pick<PullRequest, 'repo' | 'number'>): string {
	return `auto:review:${pr.repo}#${pr.number}`;
}
export function reviewTriggerKey(pr: Pick<PullRequest, 'repo' | 'number' | 'headRefOid'>): string {
	return `${reviewKeyPrefix(pr)}@${pr.headRefOid}`;
}

// Ledgers written before #209 hold the PR-only key, which the new shape would
// never match — so every PR still awaiting review would respawn on upgrade.
// Re-key those entries onto the head we see now (keeping their original
// timestamp): that PR is treated as already fired at its current head, and any
// later head fires normally. Returns whether the ledger changed.
export function migrateReviewKeys(
	prs: Pick<PullRequest, 'repo' | 'number' | 'headRefOid'>[],
	processed: ProcessedKeys
): boolean {
	let changed = false;
	for (const pr of prs) {
		const legacy = reviewKeyPrefix(pr);
		if (processed[legacy] === undefined) continue;
		processed[reviewTriggerKey(pr)] ??= processed[legacy];
		delete processed[legacy];
		changed = true;
	}
	return changed;
}

// Drop the entries a newly-fired review key supersedes: every other key for the
// same PR (older heads, plus a stray legacy entry). Without this the ledger grows
// one entry per push, forever. Returns whether the ledger changed.
export function pruneSupersededReviewKeys(
	processed: ProcessedKeys,
	pr: Pick<PullRequest, 'repo' | 'number' | 'headRefOid'>
): boolean {
	const legacy = reviewKeyPrefix(pr);
	const keep = reviewTriggerKey(pr);
	let changed = false;
	for (const k of Object.keys(processed)) {
		if (k === keep) continue;
		if (k !== legacy && !k.startsWith(`${legacy}@`)) continue;
		delete processed[k];
		changed = true;
	}
	return changed;
}

// `repo#number` identity of a PR, used to skip a review trigger while a session
// for that PR is still around. A PR stays in `review-requested:@me` until you
// review it, so without this every push mid-review would spawn another session.
export function prIdentity(pr: Pick<PullRequest, 'repo' | 'number'>): string {
	return `${pr.repo}#${pr.number}`;
}

// A candidate whose trigger key hasn't fired yet, paired with that key.
export interface NewTrigger<T> {
	key: string;
	candidate: T;
}

// From a batch of feed candidates, the ones whose key isn't already in
// `processed` — deduped within the batch too (a feed listing an item twice yields
// one trigger). Input order is preserved so spawns keep a stable order.
export function selectNewTriggers<T>(
	candidates: T[],
	keyOf: (c: T) => string,
	processed: ProcessedKeys
): NewTrigger<T>[] {
	const out: NewTrigger<T>[] = [];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		const key = keyOf(candidate);
		if (processed[key] !== undefined || seen.has(key)) continue;
		seen.add(key);
		out.push({ key, candidate });
	}
	return out;
}

// The /api/sessions body for a work session, mirroring the New Session modal's
// per-issue split: titled with the issue's display id and run in a fresh worktree whose
// branch is the issue id, off the project's remembered base (repo default when
// unset), never the project checkout itself. Seeded with the project's `template`
// (blank-safe: an empty prompt just leaves the session idle, like the UI). `issue`
// mirrors the picker's shape (source, not sourceType) so parseIssue accepts it. If
// the issue-id branch already exists, the worktree add throws and spawn releases
// the claim rather than clobbering it.
export function workBody(project: Project, issue: Issue): Record<string, unknown> {
	return {
		kind: 'claude',
		cwd: project.path,
		title: shortIssueId(issue.sourceType, issue.id),
		prompt: project.template ?? '',
		issue: { source: issue.sourceType, id: issue.id, url: issue.url, sourceId: issue.sourceId },
		worktree: { branch: issue.id, newBranch: true, base: project.lastBase || undefined }
	};
}

// The /api/sessions body for a review session, mirroring the modal: titled with the
// PR title, checking the PR head into a worktree (fromPr) with the PR's base ref
// for the Changes diff, seeded with the project's `reviewPrompt`.
export function reviewBody(project: Project, pr: PullRequest): Record<string, unknown> {
	return {
		kind: 'claude',
		cwd: project.path,
		title: pr.title,
		prompt: project.reviewPrompt ?? '',
		pr: { repo: pr.repo, number: pr.number, url: pr.url, title: pr.title },
		worktree: { fromPr: pr.number, base: pr.baseRefName }
	};
}
