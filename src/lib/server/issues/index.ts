// Aggregates issues across a project's sources behind a short in-memory TTL
// cache. On-demand only — no background polling. One source failing (bad key,
// network) surfaces as an error entry rather than sinking the whole list.
import type { ClickupSource, Issue, IssueSource, LinearSource, Project } from '$lib/types';
import { readSecret } from '../store';
import { fetchGithubIssues } from './github';
import { fetchLinearIssues } from './linear';
import { fetchClickupIssues } from './clickup';
import { getCached, setCached, type IssuesResult, type SourceError } from './cache';

// Linear/ClickUp need the stored key; GitHub rides on gh's own auth.
function fetchKeyed(source: LinearSource | ClickupSource, apiKey: string): Promise<Issue[]> {
	return source.type === 'linear' ? fetchLinearIssues(source, apiKey) : fetchClickupIssues(source, apiKey);
}

async function fetchSource(source: IssueSource): Promise<Issue[]> {
	if (source.type === 'github') return fetchGithubIssues(source);
	const apiKey = readSecret(source.id);
	if (!apiKey) throw new Error('no API key stored for this source');
	return fetchKeyed(source, apiKey);
}

export async function getProjectIssues(project: Project, refresh = false): Promise<IssuesResult> {
	if (!refresh) {
		const cached = getCached(project.path);
		if (cached) return cached;
	}

	const sources = project.sources ?? [];
	const settled = await Promise.allSettled(sources.map((s) => fetchSource(s)));

	const issues: Issue[] = [];
	const errors: SourceError[] = [];
	settled.forEach((r, i) => {
		if (r.status === 'fulfilled') issues.push(...r.value);
		else errors.push({ sourceId: sources[i].id, message: String(r.reason?.message ?? r.reason) });
	});
	issues.sort((a, b) => b.updatedAt - a.updatedAt);

	const result: IssuesResult = { issues, errors, fetchedAt: Date.now() };
	setCached(project.path, result);
	return result;
}
