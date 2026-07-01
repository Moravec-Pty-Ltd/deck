// Aggregates review-requested PRs across a project's GitHub sources behind a
// short in-memory TTL cache, mirroring the issue aggregator. On-demand only (the
// Review-mode picker); non-GitHub sources have no PR concept and are ignored, so
// a project with no GitHub source resolves to an empty list.
import type { GithubSource, Project, PullRequest } from '$lib/types';
import { fetchReviewRequestedPrs } from '../issues/github';
import { originRepo } from '../git';
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

// Keep only the GitHub sources whose repo is the one behind the project's
// `origin`. Review mode checks a picked PR out into a worktree of the project
// repo, and `pull/<n>` refs live on origin, so PRs from any other source repo
// can't be fetched — and their numbers can collide with origin's. Scoping the
// list keeps those uncheckoutable PRs out of the picker. When origin can't be
// resolved (no git repo, no origin) we don't filter, so a correctly-configured
// single-source project never blanks.
export function scopeToOrigin(sources: GithubSource[], origin: string | null): GithubSource[] {
	if (!origin) return sources;
	const want = origin.trim().toLowerCase();
	return sources.filter((s) => `${s.owner}/${s.repo}`.toLowerCase() === want);
}

// Fan out to every in-scope GitHub source at once; a failure surfaces as an
// error entry instead of sinking the whole list.
async function fanOut(project: Project): Promise<PrsResult> {
	const github = (project.sources ?? []).filter((s): s is GithubSource => s.type === 'github');
	const sources = scopeToOrigin(github, await originRepo(project.path));
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
