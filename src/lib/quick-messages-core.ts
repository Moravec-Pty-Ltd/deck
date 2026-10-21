import type { DeckSession, Project } from '$lib/types';
import { deriveGroup } from '$lib/time';

// The messages a session's picker offers: its project's first, then the global
// ones, each in stored order. A message scoped to another project is left out.
export function quickMessagesFor<T extends { projectId?: string }>(
	list: T[],
	projectId?: string | null
): T[] {
	const own = projectId ? list.filter((m) => m.projectId === projectId) : [];
	return [...own, ...list.filter((m) => !m.projectId)];
}

// The registered project a session belongs to, as a quick message's
// `projectId` (the project's path). Mirrors DeckKit's SessionProject.owning: a
// worktree's named repo wins, then deriveGroup's longest-path rule.
export function sessionProjectId(
	session: Pick<DeckSession, 'cwd' | 'worktree'>,
	projects: Project[]
): string | undefined {
	const repo = session.worktree?.repo;
	if (repo && projects.some((p) => p.path === repo)) return repo;
	const { key } = deriveGroup(session.cwd, projects);
	return projects.some((p) => p.path === key) ? key : undefined;
}

export interface ScopeGroup<T> {
	projectId?: string;
	label: string;
	items: { message: T; index: number }[];
}

// The editor's sections: Global first, then each project that has messages in
// registered-project order, then any scope whose project is no longer
// registered (labelled by its path so it can still be moved or deleted).
// `index` is the message's position in the flat list.
export function groupByScope<T extends { projectId?: string }>(
	list: T[],
	projects: Pick<Project, 'name' | 'path'>[]
): ScopeGroup<T>[] {
	const byScope = new Map<string, ScopeGroup<T>['items']>();
	list.forEach((message, index) => {
		const key = message.projectId ?? '';
		const items = byScope.get(key) ?? [];
		items.push({ message, index });
		byScope.set(key, items);
	});
	const groups: ScopeGroup<T>[] = [{ label: 'Global', items: byScope.get('') ?? [] }];
	byScope.delete('');
	for (const p of projects) {
		const items = byScope.get(p.path);
		if (!items) continue;
		groups.push({ projectId: p.path, label: p.name, items });
		byScope.delete(p.path);
	}
	for (const [path, items] of byScope) groups.push({ projectId: path, label: path, items });
	return groups;
}

// Swap a message with its neighbour in the same scope, leaving every other
// message where it is. Returns the list unchanged at either end of the scope.
export function moveWithinScope<T extends { projectId?: string }>(
	list: T[],
	index: number,
	dir: -1 | 1
): T[] {
	const scope = list[index]?.projectId;
	let j = index + dir;
	while (j >= 0 && j < list.length && list[j].projectId !== scope) j += dir;
	if (j < 0 || j >= list.length) return list;
	const next = [...list];
	[next[index], next[j]] = [next[j], next[index]];
	return next;
}

// Give a message a new scope, placing it last in that scope's section.
export function setScope<T extends { projectId?: string }>(
	list: T[],
	index: number,
	projectId?: string
): T[] {
	const moved = { ...list[index], projectId: projectId || undefined };
	return [...list.slice(0, index), ...list.slice(index + 1), moved];
}
