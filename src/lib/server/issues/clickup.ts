// ClickUp source: fetch tasks assigned to the key owner in the selected list +
// statuses, plus the team → space → folder? → list config cascade and the
// list's statuses. Talks straight to the ClickUp v2 REST API with the user's key.
import type { ClickupSource, Issue, IssueBlocker } from '$lib/types';

const CU_API = 'https://api.clickup.com/api/v2';
// Cap each call so a stalled upstream can't wedge the request, especially with
// concurrent blocker lookups fanning out.
const CU_TIMEOUT_MS = 15_000;

export async function cu<T>(apiKey: string, path: string): Promise<T> {
	const res = await fetch(`${CU_API}${path}`, {
		headers: { authorization: apiKey },
		signal: AbortSignal.timeout(CU_TIMEOUT_MS)
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`ClickUp API ${res.status}: ${text.slice(0, 300)}`);
	return JSON.parse(text) as T;
}

// Encode an id before it's interpolated into a request path, so a value
// containing `/`, `?`, `#`, or `..` can't reshape the URL against the fixed host.
export const seg = (id: string): string => encodeURIComponent(id);

export interface ClickupMe {
	id: number;
	username: string;
}

export interface CuNamed {
	id: string;
	name: string;
}

export interface CuStatus {
	status: string;
	type: string;
}

export function clickupMe(apiKey: string): Promise<ClickupMe> {
	return cu<{ user: ClickupMe }>(apiKey, '/user').then((d) => d.user);
}

export function clickupTeams(apiKey: string): Promise<CuNamed[]> {
	return cu<{ teams: CuNamed[] }>(apiKey, '/team').then((d) => d.teams ?? []);
}

export function clickupSpaces(apiKey: string, teamId: string): Promise<CuNamed[]> {
	return cu<{ spaces: CuNamed[] }>(apiKey, `/team/${seg(teamId)}/space?archived=false`).then(
		(d) => d.spaces ?? []
	);
}

export function clickupFolders(apiKey: string, spaceId: string): Promise<CuNamed[]> {
	return cu<{ folders: CuNamed[] }>(apiKey, `/space/${seg(spaceId)}/folder?archived=false`).then(
		(d) => d.folders ?? []
	);
}

// Lists live either under a folder or directly under the space (folderless).
export function clickupLists(
	apiKey: string,
	scope: { folderId?: string; spaceId?: string }
): Promise<CuNamed[]> {
	if (!scope.folderId && !scope.spaceId) {
		throw new Error('clickupLists requires a folderId or spaceId');
	}
	const path = scope.folderId
		? `/folder/${seg(scope.folderId)}/list?archived=false`
		: `/space/${seg(scope.spaceId!)}/list?archived=false`;
	return cu<{ lists: CuNamed[] }>(apiKey, path).then((d) => d.lists ?? []);
}

export function clickupStatuses(apiKey: string, listId: string): Promise<CuStatus[]> {
	return cu<{ statuses: CuStatus[] }>(apiKey, `/list/${seg(listId)}`).then((d) => d.statuses ?? []);
}

interface CuTask {
	id: string;
	name: string;
	url: string;
	status: { status: string; type: string };
	date_updated: string;
	dependencies?: { task_id: string; depends_on: string; type?: number }[];
}

export async function fetchClickupIssues(source: ClickupSource, apiKey: string): Promise<Issue[]> {
	const params = new URLSearchParams();
	params.set('include_closed', 'false');
	params.set('subtasks', 'false');
	params.append('assignees[]', String(source.assigneeUserId));
	for (const s of source.statuses) params.append('statuses[]', s);

	const data = await cu<{ tasks: CuTask[] }>(apiKey, `/list/${seg(source.listId)}/task?${params}`);
	const tasks = data.tasks ?? [];
	const blockers = await resolveBlockers(apiKey, tasks);

	return tasks.map((t) => ({
		sourceId: source.id,
		sourceType: 'clickup' as const,
		id: `#${t.id}`,
		title: t.name,
		url: t.url,
		updatedAt: Number(t.date_updated) || 0,
		blockers: blockers.get(t.id) ?? []
	}));
}

// ClickUp models "waiting on" as a task dependency: an entry on the task whose
// `task_id` is the task itself points at the `depends_on` task it waits on.
// We resolve each unique blocker once to get its title + done state; closed ones
// don't warn. Best-effort and shallow (direct waiting-on only), so any lookup
// failure just drops that blocker rather than breaking the listing.
// ClickUp marks finished work as either the `closed` or `done` status type.
const CU_DONE = new Set(['closed', 'done']);
const BLOCKER_LOOKUP_CAP = 25;

// The ids a task is waiting on (its own "waiting-on" dependency entries).
const waitingIds = (t: CuTask) =>
	(t.dependencies ?? []).filter((d) => d.task_id === t.id && d.depends_on).map((d) => d.depends_on);

// Map each task to the ids it waits on, and the flat set of those ids.
function collectWaitingOn(tasks: CuTask[]): { waitingOn: Map<string, string[]>; wanted: Set<string> } {
	const waitingOn = new Map<string, string[]>();
	const wanted = new Set<string>();
	for (const t of tasks) {
		const ids = waitingIds(t);
		if (ids.length) {
			waitingOn.set(t.id, ids);
			for (const id of ids) wanted.add(id);
		}
	}
	return { waitingOn, wanted };
}

// Resolve one blocker id to its title, or null when done/unreachable.
async function lookupBlocker(apiKey: string, id: string): Promise<readonly [string, IssueBlocker | null]> {
	try {
		const task = await cu<CuTask>(apiKey, `/task/${seg(id)}`);
		return [id, CU_DONE.has(task.status.type) ? null : { id: `#${id}`, title: task.name }];
	} catch {
		return [id, null];
	}
}

// Resolve all blocker ids concurrently.
async function lookupBlockers(apiKey: string, ids: string[]): Promise<Map<string, IssueBlocker | null>> {
	return new Map(await Promise.all(ids.map((id) => lookupBlocker(apiKey, id))));
}

async function resolveBlockers(apiKey: string, tasks: CuTask[]): Promise<Map<string, IssueBlocker[]>> {
	const { waitingOn, wanted } = collectWaitingOn(tasks);
	if (!wanted.size) return new Map();

	const resolved = await lookupBlockers(apiKey, [...wanted].slice(0, BLOCKER_LOOKUP_CAP));
	const out = new Map<string, IssueBlocker[]>();
	for (const [taskId, ids] of waitingOn) {
		const list = ids.map((id) => resolved.get(id)).filter((b): b is IssueBlocker => !!b);
		if (list.length) out.set(taskId, list);
	}
	return out;
}
