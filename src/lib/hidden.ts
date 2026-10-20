import type { Project } from '$lib/types';
import type { SessionView } from '$lib/session-view';
import { hiddenProjectPaths } from '$lib/hidden-core';
import { deriveGroup } from '$lib/time';
import { agentPath, agentPost, sessionPath } from '$lib/agent-api';

// Browser side of hiding: two one-line POSTs the session list and the projects
// page share. The rule for what ends up hidden lives on the server (see
// server/hidden.ts); these just set the switch and let the session feed bring the
// answer back.

async function hideSession(id: string, hidden: boolean): Promise<void> {
	await agentPost(sessionPath(id, 'hidden'), { hidden });
}

export async function hideProject(path: string, hidden: boolean): Promise<void> {
	await agentPost(agentPath('projects/hidden'), { path, hidden });
}

// The hide controls a session list needs, built once against the page's live
// projects and its refresh. Both lists (the sidebar and the home page) drive
// this, so hiding behaves the same on either.
export function hideActions(projects: () => Project[], onChanged: () => void) {
	const paths = () => hiddenProjectPaths(projects());
	return {
		isProjectHidden: (path: string) => paths().has(path),
		// Whether the session's project is what hides it. Unhiding such a session
		// on its own would leave it hidden, so the control that works sits on the
		// project's header instead of the row.
		projectHides: (s: SessionView) => paths().has(deriveGroup(s.cwd, projects()).key),
		async toggleSession(s: SessionView) {
			await hideSession(s.id, !s.hidden);
			onChanged();
		},
		async toggleProject(path: string) {
			await hideProject(path, !paths().has(path));
			onChanged();
		}
	};
}
