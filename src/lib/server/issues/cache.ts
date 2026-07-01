// Tiny TTL cache for aggregated issues, kept in its own module so the store can
// invalidate it on source/project deletion without importing the aggregator
// (which imports the store — that would be a cycle). The single-flight TTL logic
// lives in the shared ttl-cache; this module just binds it to IssuesResult.
import type { Issue } from '$lib/types';
import { createTtlCache } from '../ttl-cache';

export interface SourceError {
	sourceId: string;
	message: string;
}

export interface IssuesResult {
	issues: Issue[];
	errors: SourceError[];
	fetchedAt: number;
}

const cache = createTtlCache<IssuesResult>(60_000);

// Serve the cached fetch when it's reusable, otherwise start a fresh one.
export function getOrFetch(
	projectPath: string,
	refresh: boolean,
	compute: () => Promise<IssuesResult>
): Promise<IssuesResult> {
	return cache.getOrFetch(projectPath, refresh, compute);
}

// Drop a project's entry so deleting a source/project doesn't keep serving its
// stale issues for the rest of the TTL window.
export function invalidateIssues(projectPath: string) {
	cache.invalidate(projectPath);
}
