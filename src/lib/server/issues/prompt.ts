import type { Project, SessionIssue } from '$lib/types';
import { projectForPath, resolveWithinProjects } from '../confine';
import { listProjects, readSecret } from '../store';
import { getProjectIssues } from './index';
import { buildIssuePrompt, type IssueForFetch, type IssuePromptContext } from './detail';

export interface PickedIssue {
	issue: SessionIssue;
	sourceId: string;
}

async function sourceIdFor(picked: PickedIssue, project?: Project): Promise<string | undefined> {
	if (picked.sourceId) return picked.sourceId;
	const sources = project?.sources?.filter((source) => source.type === picked.issue.source) ?? [];
	if (sources.length === 1) return sources[0].id;
	if (!project || !sources.length) return undefined;
	// Older clients omit sourceId. Match their issue against discovery rather
	// than picking an arbitrary account when a project has several sources.
	const { issues } = await getProjectIssues(project);
	const matches = issues.filter((issue) =>
		issue.sourceType === picked.issue.source && issue.id === picked.issue.id
	);
	const ids = new Set(matches.map((issue) => issue.sourceId));
	return ids.size === 1 ? matches[0].sourceId : undefined;
}

export async function issuePromptContext(
	cwd: string,
	picked: PickedIssue[]
): Promise<Partial<IssuePromptContext>> {
	if (!picked.length) return {};
	const root = resolveWithinProjects(cwd);
	if (!root) return {};
	const projectPath = projectForPath(cwd);
	const project = listProjects().find((project) => project.path === projectPath);
	const items = await Promise.all(picked.map(async (picked): Promise<IssueForFetch> => {
		try {
			const sourceId = picked.issue.source === 'github' ? undefined : await sourceIdFor(picked, project);
			return { issue: picked.issue, apiKey: sourceId ? readSecret(sourceId) : undefined };
		} catch {
			return { issue: picked.issue };
		}
	}));
	try {
		return await buildIssuePrompt(root, items);
	} catch {
		return {};
	}
}
