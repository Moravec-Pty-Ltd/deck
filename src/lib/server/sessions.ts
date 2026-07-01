import { customAlphabet } from 'nanoid';
import type { DeckSession, SessionIssue, SessionKind, SessionPR, SessionStatus } from '$lib/types';
import { isAgentKind } from '$lib/types';
import { lastPrLink } from '$lib/pr';
import {
	listStoredSessions,
	getStoredSession,
	saveSession,
	updateSession,
	removeSession,
	setSessionsMutatedHook
} from './store';
import { readTranscriptTailText } from './transcript';
import {
	listTmuxSessions,
	createTmuxSession,
	killTmuxSession,
	hasTmuxSession,
	type TmuxSession
} from './tmux';
import { agentTurnRunning, agentStop } from './agents/dispatch';
import { hasPendingAsk } from './ask';
import { stopSessionServers } from './devservers';
import { SERVER_TMUX_PREFIX } from './devservers-core';
import { removeWorktree } from './git';
import { pickShipName } from './names';
import { DEMO, demoSessions, demoSession } from './demo';

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
//
// Memoised for a short window so the simultaneous tab polls (every 5s) and the
// monitor poll (every 10s) collapse onto one computation and one
// `tmux list-sessions` exec rather than spawning one each (see #9). Concurrent
// callers share the in-flight promise; any store write busts the memo (see the
// hook below) so a poll never serves a list that contradicts the store.
const LIST_TTL_MS = 1000;
let listCache: { at: number; promise: Promise<DeckSession[]> } | null = null;

// Drop the memo on every create/update/delete/status write so freshly changed
// status or lastActiveAt show up on the next poll rather than after the TTL.
setSessionsMutatedHook(() => {
	listCache = null;
});

export function listSessions(): Promise<DeckSession[]> {
	if (DEMO) return Promise.resolve(demoSessions().sort((a, b) => b.lastActiveAt - a.lastActiveAt));
	if (listCache && Date.now() - listCache.at < LIST_TTL_MS) return listCache.promise;
	const promise = computeSessions();
	const entry = { at: Date.now(), promise };
	listCache = entry;
	// Don't pin a failed computation for the whole window; let the next call retry.
	promise.catch(() => {
		if (listCache === entry) listCache = null;
	});
	return promise;
}

// A live agent turn always reads as running; a persisted 'running' that has no
// live turn is stale, so it falls back to idle.
function agentStatus(s: DeckSession): SessionStatus {
	if (agentTurnRunning(s.id)) return 'running';
	return s.status === 'running' ? 'idle' : s.status;
}

// A managed shell's liveness comes from its tmux session; absent means dead.
function shellView(s: DeckSession, tmuxSessions: TmuxSession[]): DeckSession {
	const live = tmuxSessions.find((t) => t.name === s.tmuxName);
	if (!live) return { ...s, status: 'dead', attached: false };
	return { ...s, status: 'idle', attached: live.attached, lastActiveAt: live.activity };
}

function storedView(s: DeckSession, tmuxSessions: TmuxSession[]): DeckSession {
	return isAgentKind(s.kind)
		? { ...s, status: agentStatus(s), awaitingInput: hasPendingAsk(s.id) }
		: shellView(s, tmuxSessions);
}

// An unregistered tmux session surfaced as an adhoc terminal.
function adhocView(t: TmuxSession): DeckSession {
	return {
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
	};
}

async function computeSessions(): Promise<DeckSession[]> {
	const stored = listStoredSessions();
	const tmuxSessions = await listTmuxSessions();
	const result = stored.map((s) => storedView(s, tmuxSessions));

	const managedNames = new Set(stored.map((s) => s.tmuxName).filter(Boolean));
	for (const t of tmuxSessions) {
		// Dev-server panes belong to their parent session's Servers tab (issue #32),
		// not the flat list, so they're excluded from adhoc-shell surfacing.
		if (managedNames.has(t.name) || t.name.startsWith(SERVER_TMUX_PREFIX)) continue;
		result.push(adhocView(t));
	}

	return result.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

// One-time best-effort PR backfill for sessions whose links predate capture (or
// that opened a PR before the chip existed): scan the bounded transcript tail for
// the most recent GitHub PR URL and persist it so the header chip lights up on
// open without waiting for a new event. Marked done regardless of outcome, so it
// runs at most once and a later dismissed `pr` is not resurrected on reload.
function backfillPr(id: string, alreadyBackfilled?: boolean): SessionPR | undefined {
	if (alreadyBackfilled) return undefined;
	const match = lastPrLink(readTranscriptTailText(id));
	const pr = match ? { ...match, seenAt: Date.now() } : undefined;
	updateSession(id, pr ? { pr, prBackfilled: true } : { prBackfilled: true });
	return pr;
}

// Derived live view of a stored agent session: the live run status plus a
// one-time PR backfill so the header chip lights up on open.
function agentSessionView(id: string, stored: DeckSession): DeckSession {
	const pr = stored.pr ?? backfillPr(id, stored.prBackfilled);
	return { ...stored, status: agentStatus(stored), pr };
}

export async function getSession(id: string): Promise<DeckSession | undefined> {
	if (DEMO) return demoSession(id);
	if (id.startsWith('t_')) {
		return (await listSessions()).find((s) => s.id === id);
	}
	const stored = getStoredSession(id);
	if (!stored) return undefined;
	if (isAgentKind(stored.kind)) return agentSessionView(id, stored);
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
	worktree?: { repo: string; branch: string; createdBranch: boolean; base?: string };
	issues?: SessionIssue[];
	pr?: SessionPR;
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
		issues: input.issues?.length ? input.issues : undefined,
		// Seeded in Review mode so the header PR chip lights up immediately; the
		// background sync (server/pr.ts) hydrates its live status on the next tick.
		pr: input.pr
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
		// Adhoc tmux session: no store write, so bust the list memo by hand.
		await killTmuxSession(id.slice(2));
		listCache = null;
		return;
	}
	const stored = getStoredSession(id);
	if (stored && isAgentKind(stored.kind)) {
		agentStop(id);
		// Tear down any dev servers running on this session's worktree (issue #32).
		await stopSessionServers(id).catch(() => {});
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
