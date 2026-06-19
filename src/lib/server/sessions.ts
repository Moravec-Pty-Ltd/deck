import { customAlphabet } from 'nanoid';
import type { DeckSession, SessionIssue, SessionKind } from '$lib/types';
import { isAgentKind } from '$lib/types';
import { listStoredSessions, getStoredSession, saveSession, removeSession } from './store';
import { listTmuxSessions, createTmuxSession, killTmuxSession, hasTmuxSession } from './tmux';
import { agentTurnRunning, agentStop } from './agents/dispatch';
import { removeWorktree } from './git';
import { pickShipName } from './names';

const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 8);

const ID_PREFIX: Record<SessionKind, string> = { claude: 'c', pi: 'p', codex: 'x', shell: 's' };
function newId(kind: SessionKind) {
	return `${ID_PREFIX[kind]}_${nanoid()}`;
}

function tmuxNameFor(id: string) {
	return `deck-${id.replace(/^s_/, '')}`;
}

// Flat, recency-sorted view across claude sessions and every live tmux session
// (managed or not), so adhoc terminals show up without registration.
export async function listSessions(): Promise<DeckSession[]> {
	const stored = listStoredSessions();
	const tmuxSessions = await listTmuxSessions();
	const result: DeckSession[] = [];

	for (const s of stored) {
		if (isAgentKind(s.kind)) {
			const running = agentTurnRunning(s.id);
			const status = running ? 'running' : s.status === 'running' ? 'idle' : s.status;
			result.push({ ...s, status });
		} else {
			const live = tmuxSessions.find((t) => t.name === s.tmuxName);
			result.push({
				...s,
				status: live ? 'idle' : 'dead',
				attached: live?.attached ?? false,
				lastActiveAt: live?.activity ?? s.lastActiveAt
			});
		}
	}

	const managedNames = new Set(stored.map((s) => s.tmuxName).filter(Boolean));
	for (const t of tmuxSessions) {
		if (managedNames.has(t.name)) continue;
		result.push({
			id: `t_${t.name}`,
			kind: 'shell',
			title: t.name,
			cwd: t.cwd,
			createdAt: t.created,
			lastActiveAt: t.activity,
			status: 'idle',
			tmuxName: t.name,
			managed: false,
			attached: t.attached
		});
	}

	return result.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

export async function getSession(id: string): Promise<DeckSession | undefined> {
	if (id.startsWith('t_')) {
		return (await listSessions()).find((s) => s.id === id);
	}
	const stored = getStoredSession(id);
	if (!stored) return undefined;
	if (isAgentKind(stored.kind)) {
		const running = agentTurnRunning(id);
		const status = running ? 'running' : stored.status === 'running' ? 'idle' : stored.status;
		return { ...stored, status };
	}
	const alive = stored.tmuxName ? await hasTmuxSession(stored.tmuxName) : false;
	return { ...stored, status: alive ? 'idle' : 'dead' };
}

export async function createSession(input: {
	kind: SessionKind;
	title?: string;
	cwd: string;
	model?: string;
	provider?: string;
	permissionMode?: DeckSession['permissionMode'];
	command?: string;
	worktree?: { repo: string; branch: string; createdBranch: boolean };
	issue?: SessionIssue;
}): Promise<DeckSession> {
	const id = newId(input.kind);
	const now = Date.now();
	// Untitled shells get a Star Trek starship name; agents fall back to the
	// directory name so the title still hints at what they're working on.
	const title =
		input.title?.trim() ||
		(input.kind === 'shell'
			? pickShipName(listStoredSessions().map((s) => s.title))
			: input.cwd.split('/').pop() || id);

	const session: DeckSession = {
		id,
		kind: input.kind,
		title,
		cwd: input.cwd,
		createdAt: now,
		lastActiveAt: now,
		status: 'idle',
		managed: true,
		worktree: input.worktree,
		issue: input.issue
	};

	if (isAgentKind(input.kind)) {
		session.model = input.model || undefined;
		session.provider = input.provider || undefined;
		if (input.kind === 'claude') session.permissionMode = input.permissionMode ?? 'acceptEdits';
	} else {
		session.tmuxName = tmuxNameFor(id);
		await createTmuxSession(session.tmuxName, input.cwd, input.command);
	}

	saveSession(session);
	return session;
}

export async function deleteSession(
	id: string,
	opts: { deleteWorktree?: boolean; deleteBranch?: boolean } = {}
): Promise<void> {
	if (id.startsWith('t_')) {
		await killTmuxSession(id.slice(2));
		return;
	}
	const stored = getStoredSession(id);
	if (stored && isAgentKind(stored.kind)) {
		agentStop(id);
	} else if (stored?.tmuxName && (await hasTmuxSession(stored.tmuxName))) {
		await killTmuxSession(stored.tmuxName);
	}

	if (opts.deleteWorktree && stored?.worktree) {
		try {
			await removeWorktree(stored.worktree.repo, stored.cwd, {
				deleteBranch: opts.deleteBranch && stored.worktree.createdBranch,
				branch: stored.worktree.branch
			});
		} catch {
			// leave the stored session removed even if worktree cleanup fails
		}
	}

	removeSession(id);
}
