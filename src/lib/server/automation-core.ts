// Pure trigger-key + dedupe logic and the /api/sessions request bodies for feed
// automation (issue #171), kept node-free so they unit-test without fs/gh. The
// orchestration (feed fetch, session create, notify, durable ledger) lives in the
// sibling automation.ts.
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

// Deterministic per-PR key: the origin repo and PR number.
export function reviewTriggerKey(pr: Pick<PullRequest, 'repo' | 'number'>): string {
	return `auto:review:${pr.repo}#${pr.number}`;
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
// per-issue split: titled with the issue id and run in a fresh worktree whose
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
		title: issue.id,
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
