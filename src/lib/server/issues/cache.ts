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
const cache = new Map<string, IssuesResult>();

export function getCached(projectPath: string): IssuesResult | undefined {
	const hit = cache.get(projectPath);
	if (hit && Date.now() - hit.fetchedAt < TTL_MS) return hit;
	return undefined;
}

export function setCached(projectPath: string, result: IssuesResult) {
	cache.set(projectPath, result);
}

// Drop a project's entry so deleting a source/project doesn't keep serving its
// stale issues for the rest of the TTL window.
export function invalidateIssues(projectPath: string) {
	cache.delete(projectPath);
}
