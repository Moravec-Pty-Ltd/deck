// Pure trigger-key + dedupe logic for feed automation (issue #171), kept node-free
// so it unit-tests without fs/gh. The orchestration (feed fetch, session create,
// notify, durable ledger) lives in the sibling automation.ts.
import type { Issue, PullRequest } from '$lib/types';

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
