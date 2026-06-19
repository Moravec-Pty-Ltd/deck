// GitHub source: open issues assigned to the authenticated `gh` user in a
// repo, driven entirely through the `gh` CLI (already a deck dependency, no
// stored secret). Blockers come from incomplete sub-issues, looked up in one
// batched GraphQL call and treated as best-effort.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GithubSource, Issue, IssueBlocker } from '$lib/types';

const exec = promisify(execFile);

// Cap each gh call so a hung CLI (auth prompt, dead network) can't wedge the
// request; both the issue list and the sub-issues query go through here.
const GH_TIMEOUT_MS = 15_000;

async function gh(args: string[]): Promise<string> {
	const { stdout } = await exec('gh', args, { maxBuffer: 16 * 1024 * 1024, timeout: GH_TIMEOUT_MS });
	return stdout;
}

interface GhIssue {
	number: number;
	title: string;
	url: string;
	updatedAt: string;
}

export async function fetchGithubIssues(source: GithubSource): Promise<Issue[]> {
	const repo = `${source.owner}/${source.repo}`;
	const out = await gh([
		'issue',
		'list',
		'-R',
		repo,
		'--assignee',
		'@me',
		'--state',
		'open',
		'--limit',
		'100',
		'--json',
		'number,title,url,updatedAt'
	]);
	const items = JSON.parse(out) as GhIssue[];
	const blockers = await subIssueBlockers(source, items.map((i) => i.number));

	return items.map((i) => ({
		sourceId: source.id,
		sourceType: 'github' as const,
		id: `${repo}#${i.number}`,
		title: i.title,
		url: i.url,
		updatedAt: Date.parse(i.updatedAt) || 0,
		blockers: blockers.get(i.number) ?? []
	}));
}

interface SubIssuesResult {
	number: number;
	title: string;
	state: string;
}

type RepoEntries = Record<string, { subIssues?: { nodes: SubIssuesResult[] } } | null>;

function repositoryData(raw: string): RepoEntries {
	return (JSON.parse(raw)?.data?.repository ?? {}) as RepoEntries;
}

function openSubIssues(entry: RepoEntries[string], repo: string): IssueBlocker[] {
	const nodes = entry?.subIssues?.nodes ?? [];
	return nodes.filter((s) => s.state === 'OPEN').map((s) => ({ id: `${repo}#${s.number}`, title: s.title }));
}

function parseSubIssues(repository: RepoEntries, repo: string, numbers: number[]): Map<number, IssueBlocker[]> {
	const out = new Map<number, IssueBlocker[]>();
	for (const n of numbers) {
		const open = openSubIssues(repository[`i${n}`], repo);
		if (open.length) out.set(n, open);
	}
	return out;
}

// One aliased GraphQL request fetches every issue's sub-issues at once. Open
// sub-issues count as incomplete blockers. The whole thing is wrapped: if the
// schema lacks the field or the call fails, we simply report no blockers.
async function subIssueBlockers(source: GithubSource, numbers: number[]): Promise<Map<number, IssueBlocker[]>> {
	if (!numbers.length) return new Map();

	const repo = `${source.owner}/${source.repo}`;
	const aliases = numbers
		.map((n) => `i${n}: issue(number: ${n}) { subIssues(first: 50) { nodes { number title state } } }`)
		.join('\n');
	const query = `query($o: String!, $r: String!) { repository(owner: $o, name: $r) {\n${aliases}\n} }`;

	try {
		const raw = await gh(['api', 'graphql', '-f', `query=${query}`, '-F', `o=${source.owner}`, '-F', `r=${source.repo}`]);
		return parseSubIssues(repositoryData(raw), repo, numbers);
	} catch {
		// sub-issues unsupported or call failed — warnings are non-blocking.
		return new Map();
	}
}
