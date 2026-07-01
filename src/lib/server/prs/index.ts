// Aggregates review-requested PRs across a project's GitHub sources behind a
// short in-memory TTL cache, mirroring the issue aggregator. On-demand only (the
// Review-mode picker); non-GitHub sources have no PR concept and are ignored, so
// a project with no GitHub source resolves to an empty list.
import type { GithubSource, Project, PullRequest } from '$lib/types';
import { fetchReviewRequestedPrs } from '../issues/github';
import { createTtlCache } from '../ttl-cache';

export interface PrSourceError {
	sourceId: string;
	message: string;
}

export interface PrsResult {
	prs: PullRequest[];
	errors: PrSourceError[];
	fetchedAt: number;
}

const cache = createTtlCache<PrsResult>(60_000);

export function getProjectPrs(project: Project, refresh = false): Promise<PrsResult> {
	// Single-flight: concurrent misses for one project share the fan-out.
	return cache.getOrFetch(project.path, refresh, () => fanOut(project));
}

// Drop a project's entry so adding/removing a source or deleting the project
// doesn't keep serving its stale PR list for the rest of the TTL window (mirrors
// invalidateIssues; called from the same store mutations).
export function invalidatePrs(projectPath: string): void {
	cache.invalidate(projectPath);
}

// Fan out to every GitHub source at once; a failure surfaces as an error entry
// instead of sinking the whole list.
async function fanOut(project: Project): Promise<PrsResult> {
	const sources = (project.sources ?? []).filter((s): s is GithubSource => s.type === 'github');
	const settled = await Promise.allSettled(sources.map((s) => fetchReviewRequestedPrs(s)));

	const prs: PullRequest[] = [];
	const errors: PrSourceError[] = [];
	settled.forEach((r, i) => {
		if (r.status === 'fulfilled') prs.push(...r.value);
		else errors.push({ sourceId: sources[i].id, message: String(r.reason?.message ?? r.reason) });
	});
	prs.sort((a, b) => b.updatedAt - a.updatedAt);

	return { prs, errors, fetchedAt: Date.now() };
}
