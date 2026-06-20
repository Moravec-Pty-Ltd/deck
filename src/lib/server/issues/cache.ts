// Tiny TTL cache for aggregated issues, kept in its own module so the store can
// invalidate it on source/project deletion without importing the aggregator
// (which imports the store — that would be a cycle).
import type { Issue } from '$lib/types';

export interface SourceError {
	sourceId: string;
	message: string;
}

export interface IssuesResult {
	issues: Issue[];
	errors: SourceError[];
	fetchedAt: number;
}

const TTL_MS = 60_000;

// Each slot caches the fetch *promise*, not just its resolved value, so
// concurrent cache misses share the one in-flight promise instead of each
// fanning out to the providers — single-flight, so a cold cache (first open,
// post-TTL, post-invalidate, or refresh=1) no longer stampedes N callers into N
// identical fan-outs (see #8). `at` is the fetch-START time, so the TTL window
// is measured from when work began and a slow fan-out can't extend its own
// lifetime. Once it resolves the same promise keeps serving until the TTL
// lapses; a rejected fetch is dropped so the next caller retries rather than
// being pinned to a failed promise.
interface Slot {
	at: number;
	promise: Promise<IssuesResult>;
	settled: boolean;
}

const cache = new Map<string, Slot>();

// Serve the cached fetch when it's reusable, otherwise start a fresh one.
export function getOrFetch(
	projectPath: string,
	refresh: boolean,
	compute: () => Promise<IssuesResult>
): Promise<IssuesResult> {
	const hit = cache.get(projectPath);
	if (hit && reusable(hit, refresh)) return hit.promise;
	return startFetch(projectPath, compute);
}

// An in-flight fetch is always joined (single-flight, even under refresh — it's
// already the freshest data possible). A settled one is reused only while fresh
// and not force-refreshed.
function reusable(slot: Slot, refresh: boolean): boolean {
	if (!slot.settled) return true;
	return !refresh && Date.now() - slot.at < TTL_MS;
}

function startFetch(projectPath: string, compute: () => Promise<IssuesResult>): Promise<IssuesResult> {
	const slot: Slot = { at: Date.now(), promise: compute(), settled: false };
	cache.set(projectPath, slot);
	slot.promise.then(
		() => {
			// No identity guard needed here, unlike the reject path: this only flips
			// the slot's own flag and never writes the result back to the map, so a
			// slot that invalidateIssues evicted mid-flight stays evicted and the next
			// call refetches. Keep it write-back-free if this ever grows.
			slot.settled = true;
		},
		() => {
			slot.settled = true;
			// Don't pin a failed fan-out for the window; let the next call retry.
			if (cache.get(projectPath) === slot) cache.delete(projectPath);
		}
	);
	return slot.promise;
}

// Drop a project's entry so deleting a source/project doesn't keep serving its
// stale issues for the rest of the TTL window.
export function invalidateIssues(projectPath: string) {
	cache.delete(projectPath);
}
