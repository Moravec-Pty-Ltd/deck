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

// The context fetched for a prompt's [issue_*] tokens. Every field is optional
// because the fetch is best effort; `warnings` names each issue whose context
// is missing and why, for the transcript to show.
export type IssueContext = Partial<IssuePromptContext>;

// Resolve the credential an issue's context needs. GitHub uses gh's own auth; a
// keyed tracker needs the source id, which the picker sends and older clients
// leave for the project to disambiguate.
async function itemFor(picked: PickedIssue, project?: Project): Promise<IssueForFetch> {
	const { issue } = picked;
	if (issue.source === 'github') return { issue };
	try {
		const sourceId = await sourceIdFor(picked, project);
		return { issue, apiKey: sourceId ? readSecret(sourceId) : undefined };
	} catch {
		return { issue };
	}
}

export async function issuePromptContext(cwd: string, picked: PickedIssue[]): Promise<IssueContext> {
	if (!picked.length) return {};
	const root = resolveWithinProjects(cwd);
	if (!root) return { warnings: ['issue context skipped: the session directory is outside the registered projects'] };
	const projectPath = projectForPath(cwd);
	const project = listProjects().find((project) => project.path === projectPath);
	const items = await Promise.all(picked.map((picked) => itemFor(picked, project)));
	try {
		return await buildIssuePrompt(root, items);
	} catch (e) {
		return { warnings: [`issue context unavailable: ${e instanceof Error ? e.message : String(e)}`] };
	}
}

// Whether a prompt reads the fetched context at all; a prompt that only uses
// [issue_id]/[issue_url] loses nothing when the fetch fails, so it gets no warning.
export function wantsIssueContext(text: string): boolean {
	return /\[issue_(?:title|body|comments)\]/.test(text);
}

// The one transcript line summarising missing context, or null when everything
// the prompt asked for arrived.
export function issueContextWarning(text: string, context: IssueContext): string | null {
	const warnings = context.warnings ?? [];
	if (!warnings.length || !wantsIssueContext(text)) return null;
	return `Issue context could not be fetched, so [issue_title]/[issue_body]/[issue_comments] may be incomplete:\n- ${warnings.join('\n- ')}`;
}
