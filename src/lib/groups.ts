import type { Project } from '$lib/types';
import type { SessionView } from '$lib/session-view';
import { deriveGroup } from '$lib/time';

// The bucket for projects with no group, and for sessions whose derived project
// isn't a registered project (adhoc shells). Rendered last on every surface.
export const UNGROUPED = 'Ungrouped';

// The bucket below Ungrouped, holding what the user has hidden. Collapsed by
// default on every surface, and the only place a hidden thing can be brought
// back from.
export const HIDDEN = 'Hidden';

// One project's sessions within a group. `key`/`label` come from deriveGroup, so
// worktrees still fold back under their repo. `lastActiveAt` drives the
// activity-ordering of subgroups inside a group.
export interface ProjectSubgroup {
	key: string;
	label: string;
	sessions: SessionView[];
	lastActiveAt: number;
}

// A project-group holding its per-project session subgroups. The two-level
// structure the sidebar and homepage render: group -> project subgroup -> sessions.
export interface SessionGroup {
	name: string;
	subgroups: ProjectSubgroup[];
	sessionCount: number;
}

// Order group names alphanumerically, with "Ungrouped" second-last and "Hidden"
// last (matches the explicit placement on /projects and the new-session select).
export function compareGroupNames(a: string, b: string): number {
	if (a === b) return 0;
	const rank = (n: string) => (n === HIDDEN ? 2 : n === UNGROUPED ? 1 : 0);
	if (rank(a) !== rank(b)) return rank(a) - rank(b);
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

// The directory a session belongs by: a worktree names its repo outright, wherever
// the worktree itself sits, and everything else goes by where it runs.
export function sessionPath(s: SessionView): string {
	return s.worktree?.repo ?? s.cwd;
}

// Cluster sessions into per-project subgroups, most-recently-active first, with
// a subgroup's unread sessions ahead of the rest (issue #336).
// Shared by the ordinary grouping and by the Hidden section, so a hidden session
// still sits under the project it belongs to.
function projectSubgroups(sessions: SessionView[], projects: Project[]): ProjectSubgroup[] {
	const subMap = new Map<string, ProjectSubgroup>();
	for (const s of sessions) {
		const { key, label } = deriveGroup(sessionPath(s), projects);
		let sub = subMap.get(key);
		if (!sub) {
			sub = { key, label, sessions: [], lastActiveAt: 0 };
			subMap.set(key, sub);
		}
		sub.sessions.push(s);
		sub.lastActiveAt = Math.max(sub.lastActiveAt, s.lastActiveAt);
	}
	for (const sub of subMap.values()) sub.sessions.sort((a, b) => Number(!!b.unread) - Number(!!a.unread));
	return [...subMap.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

// Build the two-level structure: sessions cluster into per-project subgroups
// (via deriveGroup), which cluster into project-groups by their project's
// `group`. Subgroups whose project isn't registered or has no group fall under
// "Ungrouped". Groups order alphanumerically (Ungrouped last); subgroups within a
// group order by most-recent activity.
//
// Callers pass the sessions they want listed, so hidden ones are filtered out
// first (see visibleSessions) and rendered by hiddenGroup instead.
export function groupSessions(sessions: SessionView[], projects: Project[]): SessionGroup[] {
	const toGroup = pathGroups(projects);
	const subgroups = projectSubgroups(sessions, projects);

	const groupMap = new Map<string, SessionGroup>();
	for (const sub of subgroups) {
		const name = toGroup.get(sub.key) ?? UNGROUPED;
		let group = groupMap.get(name);
		if (!group) {
			group = { name, subgroups: [], sessionCount: 0 };
			groupMap.set(name, group);
		}
		group.subgroups.push(sub);
		group.sessionCount += sub.sessions.length;
	}

	// Subgroups keep the activity order projectSubgroups already put them in.
	return [...groupMap.values()].sort((a, b) => compareGroupNames(a.name, b.name));
}

// The one section every hidden session lands in, whatever project or group it
// belongs to, rendered below Ungrouped. Null when nothing is hidden, so the
// section doesn't appear at all until it has something in it. Subgroups are kept
// so you can see what you hid and unhide a whole project from its header.
export function hiddenGroup(sessions: SessionView[], projects: Project[]): SessionGroup | null {
	const hidden = sessions.filter((s) => s.hidden);
	if (hidden.length === 0) return null;
	return {
		name: HIDDEN,
		subgroups: projectSubgroups(hidden, projects),
		sessionCount: hidden.length
	};
}

// A project-group for the surfaces that list projects (no session-activity signal,
// so within-group ordering is alphanumeric by name).
export interface ProjectGroup {
	name: string;
	projects: Project[];
}

// Group projects by their `group` ("Ungrouped" fallback) for /projects and the
// new-session picker. A hidden project leaves its group for "Hidden", which is
// the point of hiding it; groups order alphanumerically (Ungrouped then Hidden
// last), and within a group projects order alphanumerically by name.
export function groupProjects(projects: Project[]): ProjectGroup[] {
	const map = new Map<string, Project[]>();
	for (const p of projects) {
		const name = p.hidden ? HIDDEN : p.group?.trim() || UNGROUPED;
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

// One line in the group switcher. `name` is null for "All", so a project group
// can be called anything; `count` is how many of its sessions need you.
export interface GroupEntry {
	name: string | null;
	label: string;
	count: number;
}

// The group a directory belongs to, through its project: worktrees fold back to
// their repo, and anything outside a registered project counts as Ungrouped.
export function groupOfPath(path: string, projects: Project[]): string {
	return pathGroups(projects).get(deriveGroup(path, projects).key) ?? UNGROUPED;
}

// What the switcher lists: All, each group, then Ungrouped when a project or a
// session lands there (an adhoc shell's question must have somewhere to show).
// Empty when no project has a group, since there is nothing to switch between.
export function groupEntries(sessions: SessionView[], projects: Project[]): GroupEntry[] {
	const names = existingGroupNames(projects).filter((n) => n !== UNGROUPED);
	if (names.length === 0) return [];
	const counts = new Map<string, number>();
	let total = 0;
	let hasUngrouped = projects.some((p) => !p.group?.trim());
	for (const s of sessions) {
		const name = groupOfPath(sessionPath(s), projects);
		if (name === UNGROUPED) hasUngrouped = true;
		if (s.hidden || !(s.awaitingInput || s.unread)) continue;
		counts.set(name, (counts.get(name) ?? 0) + 1);
		total++;
	}
	const groups = hasUngrouped ? [...names, UNGROUPED] : names;
	return [
		{ name: null, label: 'All', count: total },
		...groups.map((name) => ({ name, label: name, count: counts.get(name) ?? 0 }))
	];
}

// The selection in force: what was picked while it still exists, else All.
export function resolveGroup(picked: string | null, entries: GroupEntry[]): string | null {
	return entries.some((e) => e.name === picked) ? picked : null;
}

// Whether a group other than the selected one has something waiting. All shows
// everything, so nothing is ever elsewhere.
export function waitingElsewhere(entries: GroupEntry[], selected: string | null): boolean {
	return selected !== null && entries.some((e) => e.name !== null && e.name !== selected && e.count > 0);
}

// The items in the selected group, each placed by the directory `pathOf` gives.
// Sessions, runs and schedules all narrow through here.
export function inGroup<T>(
	items: T[],
	pathOf: (item: T) => string,
	projects: Project[],
	selected: string | null
): T[] {
	if (selected === null) return items;
	return items.filter((item) => groupOfPath(pathOf(item), projects) === selected);
}

// The selection after opening a session: one in another group brings its group
// along, so it isn't left open but missing from the list.
export function groupAfterOpening(session: SessionView, projects: Project[], selected: string | null): string | null {
	if (selected === null) return null;
	return groupOfPath(sessionPath(session), projects);
}

export const OTHER_GROUPS = 'Other groups';

// The new-session picker with a group selected: that group first, the rest under
// "Other groups", Hidden still last.
export function pickerGroups(projects: Project[], selected: string | null): ProjectGroup[] {
	const all = groupProjects(projects);
	if (selected === null) return all;
	const others = all
		.filter((g) => g.name !== selected && g.name !== HIDDEN)
		.flatMap((g) => g.projects)
		.sort((a, b) => a.name.localeCompare(b.name));
	return [
		...all.filter((g) => g.name === selected),
		...(others.length ? [{ name: OTHER_GROUPS, projects: others }] : []),
		...all.filter((g) => g.name === HIDDEN)
	];
}

// The project the new-session picker lands on: `current` while it fits the
// selected group, else the group's first project, else `current` regardless.
export function startProject(projects: Project[], selected: string | null, current: string): string {
	const fallback = current || (projects[0]?.path ?? '');
	if (selected === null) return fallback;
	const first = groupProjects(projects).find((g) => g.name === selected)?.projects ?? [];
	return first.some((p) => p.path === current) ? current : (first[0]?.path ?? fallback);
}
