import { browser } from '$app/environment';
import type { Project } from '$lib/types';
import type { SessionView } from '$lib/session-view';
import { groupAfterOpening, groupEntries, resolveGroup, waitingElsewhere } from '$lib/groups';

const KEY = 'deck:group';

function load(): string | null {
	if (!browser) return null;
	try {
		return localStorage.getItem(KEY);
	} catch {
		return null;
	}
}

// Kept as picked rather than cleared when the group goes away, so a list that
// hasn't loaded yet can never lose the choice; resolveGroup falls back to All.
let picked = $state<string | null>(load());
let sessions = $state.raw<SessionView[]>([]);
let projects = $state.raw<Project[]>([]);
let projectsLoaded = false;
let opening: string | null = null;

const entries = $derived(groupEntries(sessions, projects));
const selected = $derived(resolveGroup(picked, entries));

function pick(name: string | null) {
	picked = name;
	if (!browser) return;
	try {
		if (name === null) localStorage.removeItem(KEY);
		else localStorage.setItem(KEY, name);
	} catch {
		// Keep the in-memory choice; persistence is non-critical.
	}
}

// Waits for the data a cold open from a notification doesn't have yet.
function followOpening() {
	if (!projectsLoaded) return;
	const session = sessions.find((s) => s.id === opening);
	if (!session) return;
	opening = null;
	const next = groupAfterOpening(session, projects, selected);
	if (next !== selected) pick(next);
}

// One module-level store shared by every importer, so each surface reads the same
// selection. InboxWatch feeds it, being the one feed every page already holds.
export const groupSwitch = {
	get selected() {
		return selected;
	},
	get entries() {
		return entries;
	},
	get waitingElsewhere() {
		return waitingElsewhere(entries, selected);
	},
	get sessions() {
		return sessions;
	},
	get projects() {
		return projects;
	},
	pick,
	setSessions(next: SessionView[]) {
		sessions = next;
		followOpening();
	},
	setProjects(next: Project[]) {
		projects = next;
		projectsLoaded = true;
		followOpening();
	},
	opened(sessionId: string) {
		opening = sessionId;
		followOpening();
	}
};
