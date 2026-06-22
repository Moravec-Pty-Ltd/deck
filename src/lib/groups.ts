import type { DeckSession, Project } from '$lib/types';
import { deriveGroup } from '$lib/time';

// The bucket for projects with no group, and for sessions whose derived project
// isn't a registered project (adhoc shells). Rendered last on every surface.
export const UNGROUPED = 'Ungrouped';

// One project's sessions within a group. `key`/`label` come from deriveGroup, so
// worktrees still fold back under their repo. `lastActiveAt` drives the
// activity-ordering of subgroups inside a group.
export interface ProjectSubgroup {
	key: string;
	label: string;
	sessions: DeckSession[];
	lastActiveAt: number;
}

// A project-group holding its per-project session subgroups. The two-level
// structure the sidebar and homepage render: group -> project subgroup -> sessions.
export interface SessionGroup {
	name: string;
	subgroups: ProjectSubgroup[];
	sessionCount: number;
}

// Order group names alphanumerically, with "Ungrouped" always last (matches the
// explicit placement on /projects and the new-session select).
export function compareGroupNames(a: string, b: string): number {
	if (a === b) return 0;
	if (a === UNGROUPED) return 1;
	if (b === UNGROUPED) return -1;
	return a.localeCompare(b);
}

// Map a registered project path to its trimmed group name (blank groups ignored).
function pathGroups(projects: Project[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const p of projects) {
		const g = p.group?.trim();
		if (g) map.set(p.path, g);
	}
	return map;
}

// Build the two-level structure: sessions cluster into per-project subgroups
// (via deriveGroup), which cluster into project-groups by their project's
// `group`. Subgroups whose project isn't registered or has no group fall under
// "Ungrouped". Groups order alphanumerically (Ungrouped last); subgroups within a
// group order by most-recent activity.
export function groupSessions(sessions: DeckSession[], projects: Project[]): SessionGroup[] {
	const toGroup = pathGroups(projects);

	const subMap = new Map<string, ProjectSubgroup>();
	for (const s of sessions) {
		const { key, label } = deriveGroup(s.cwd, projects);
		let sub = subMap.get(key);
		if (!sub) {
			sub = { key, label, sessions: [], lastActiveAt: 0 };
			subMap.set(key, sub);
		}
		sub.sessions.push(s);
		sub.lastActiveAt = Math.max(sub.lastActiveAt, s.lastActiveAt);
	}

	const groupMap = new Map<string, SessionGroup>();
	for (const sub of subMap.values()) {
		const name = toGroup.get(sub.key) ?? UNGROUPED;
		let group = groupMap.get(name);
		if (!group) {
			group = { name, subgroups: [], sessionCount: 0 };
			groupMap.set(name, group);
		}
		group.subgroups.push(sub);
		group.sessionCount += sub.sessions.length;
	}

	for (const group of groupMap.values()) {
		group.subgroups.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
	}
	return [...groupMap.values()].sort((a, b) => compareGroupNames(a.name, b.name));
}

// A project-group for the surfaces that list projects (no session-activity signal,
// so within-group ordering is alphanumeric by name).
export interface ProjectGroup {
	name: string;
	projects: Project[];
}

// Group projects by their `group` ("Ungrouped" fallback) for /projects and the
// new-session picker. Groups order alphanumerically (Ungrouped last); within a
// group, projects order alphanumerically by name.
export function groupProjects(projects: Project[]): ProjectGroup[] {
	const map = new Map<string, Project[]>();
	for (const p of projects) {
		const name = p.group?.trim() || UNGROUPED;
		let list = map.get(name);
		if (!list) {
			list = [];
			map.set(name, list);
		}
		list.push(p);
	}
	for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
	return [...map.entries()]
		.map(([name, projs]) => ({ name, projects: projs }))
		.sort((a, b) => compareGroupNames(a.name, b.name));
}

// The distinct, sorted group names in use, for a <datalist> of suggestions.
export function existingGroupNames(projects: Project[]): string[] {
	const set = new Set<string>();
	for (const p of projects) {
		const g = p.group?.trim();
		if (g) set.add(g);
	}
	return [...set].sort((a, b) => a.localeCompare(b));
}
