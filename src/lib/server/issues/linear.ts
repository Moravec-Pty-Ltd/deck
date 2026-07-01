// Linear source: fetch issues assigned to the key owner in the selected team +
// states, plus config-time lookups (me / teams / states) used while adding a
// source. Talks straight to Linear's GraphQL API with the user's personal key.
import type { Issue, LinearSource } from '$lib/types';

const LINEAR_API = 'https://api.linear.app/graphql';
// Cap each call so a stalled upstream can't wedge the request.
const LINEAR_TIMEOUT_MS = 15_000;

export async function graphql<T>(
	apiKey: string,
	query: string,
	variables: Record<string, unknown> = {}
): Promise<T> {
	const res = await fetch(LINEAR_API, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: apiKey },
		body: JSON.stringify({ query, variables }),
		signal: AbortSignal.timeout(LINEAR_TIMEOUT_MS)
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`Linear API ${res.status}: ${text.slice(0, 300)}`);
	const body = JSON.parse(text) as { data?: T; errors?: { message: string }[] };
	if (body.errors?.length) throw new Error(`Linear API: ${body.errors.map((e) => e.message).join('; ')}`);
	return body.data as T;
}

export interface LinearMe {
	id: string;
	name: string;
	email: string;
}

export interface LinearTeam {
	id: string;
	name: string;
	key: string;
}

export interface LinearState {
	id: string;
	name: string;
	type: string;
}

export function linearMe(apiKey: string): Promise<LinearMe> {
	return graphql<{ viewer: LinearMe }>(apiKey, 'query { viewer { id name email } }').then((d) => d.viewer);
}

export function linearTeams(apiKey: string): Promise<LinearTeam[]> {
	return graphql<{ teams: { nodes: LinearTeam[] } }>(
		apiKey,
		'query { teams(first: 250) { nodes { id name key } } }'
	).then((d) => d.teams.nodes);
}

export function linearStates(apiKey: string, teamId: string): Promise<LinearState[]> {
	return graphql<{ team: { states: { nodes: (LinearState & { position: number })[] } } }>(
		apiKey,
		'query($id: String!) { team(id: $id) { states { nodes { id name type position } } } }',
		{ id: teamId }
	).then((d) => d.team.states.nodes.sort((a, b) => a.position - b.position));
}

// Quick-pick cap: first 100, matching the GitHub (`--limit 100`) and ClickUp
// list paths. The picker is a shortlist, not an exhaustive browser, so the
// three providers cap rather than paginate.
const ISSUES_QUERY = `query($f: IssueFilter) {
	issues(filter: $f, first: 100) {
		nodes {
			identifier title url updatedAt
			state { type }
			inverseRelations { nodes { type issue { identifier title state { type } } } }
		}
	}
}`;

interface LinearIssueNode {
	identifier: string;
	title: string;
	url: string;
	updatedAt: string;
	state: { type: string };
	inverseRelations: {
		nodes: { type: string; issue: { identifier: string; title: string; state: { type: string } } }[];
	};
}

// A Linear state is "done" (so not a live blocker) when completed or canceled.
const isDone = (type?: string) => type === 'completed' || type === 'canceled';

export async function fetchLinearIssues(source: LinearSource, apiKey: string): Promise<Issue[]> {
	const filter: Record<string, unknown> = { assignee: { isMe: { eq: true } } };
	if (source.teamId) filter.team = { id: { eq: source.teamId } };
	if (source.stateIds.length) filter.state = { id: { in: source.stateIds } };

	const data = await graphql<{ issues: { nodes: LinearIssueNode[] } }>(apiKey, ISSUES_QUERY, {
		f: filter
	});

	return data.issues.nodes.map((n) => ({
		sourceId: source.id,
		sourceType: 'linear' as const,
		id: n.identifier,
		title: n.title,
		url: n.url,
		updatedAt: Date.parse(n.updatedAt) || 0,
		// X is blocked by Y when Y "blocks" X — i.e. an inverse "blocks" relation.
		blockers: (n.inverseRelations?.nodes ?? [])
			.filter((r) => r.type === 'blocks' && !isDone(r.issue?.state?.type))
			.map((r) => ({ id: r.issue.identifier, title: r.issue.title }))
	}));
}
