// Durable state for watches (issue #277): every watch in ~/.deck/watches.json,
// read once and written whole on each change, the same bargain schedules make.
// The create / list / cancel calls live here rather than in watcher.ts so that
// sessions.ts can cancel a deleted session's watches without an import cycle.
import { customAlphabet } from 'nanoid';
import { readJson, watchMaxDelayMs, writeJson } from './config';
import { publishAgentEvent } from './agent-feed';
import { getStoredSession } from './store';
import { CHECK_NOT_ALLOWED, WatchError, activeFor, capReached, checkAllowed, parseWatchRequest, prune } from './watch-core';
import type { Watch } from '$lib/watches';

const FILE = 'watches.json';

const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 8);

interface WatchesFile {
	watches: Watch[];
}

// Survives HMR in dev so the tick, the MCP tools and the routes share one copy.
const g = globalThis as { __deckWatches?: WatchesFile };

function state(): WatchesFile {
	if (!g.__deckWatches) {
		const raw = readJson<Partial<WatchesFile>>(FILE, {});
		g.__deckWatches = { watches: Array.isArray(raw.watches) ? raw.watches : [] };
	}
	return g.__deckWatches;
}

export function listWatches(sessionId?: string): Watch[] {
	const all = prune(state().watches, Date.now());
	return sessionId ? all.filter((w) => w.sessionId === sessionId) : all;
}

export function getWatch(id: string): Watch | undefined {
	return state().watches.find((w) => w.id === id);
}

export function activeWatches(sessionId: string): Watch[] {
	return activeFor(state().watches, sessionId);
}

// Clients follow a session's active watches on the event cursor, like its status.
function announce(sessionId: string): void {
	publishAgentEvent(sessionId, 'watches', { watches: activeWatches(sessionId) });
}

// Insert or replace a watch, drop expired history, and write the file.
export function saveWatch(watch: Watch): void {
	const s = state();
	const i = s.watches.findIndex((w) => w.id === watch.id);
	if (i === -1) s.watches.push(watch);
	else s.watches[i] = watch;
	s.watches = prune(s.watches, Date.now());
	writeJson(FILE, s);
	announce(watch.sessionId);
}

// Throws a WatchError the MCP tool hands back to the agent as text.
export function createWatch(sessionId: string, raw: unknown): Watch {
	const now = Date.now();
	const input = parseWatchRequest(raw, now, watchMaxDelayMs);
	const session = getStoredSession(sessionId);
	if (input.command && !(session && checkAllowed(session))) throw new WatchError(CHECK_NOT_ALLOWED);
	if (capReached(state().watches, sessionId)) {
		throw new WatchError('this session already has 5 active watches; cancel one with unwatch first');
	}
	const watch: Watch = { id: `wat_${nanoid()}`, sessionId, ...input, createdAt: now, state: 'active' };
	saveWatch(watch);
	return watch;
}

// Cancels an active watch; an ended one comes back as it is. Undefined when unknown.
export function cancelWatch(id: string): Watch | undefined {
	const watch = getWatch(id);
	if (!watch || watch.state !== 'active') return watch;
	const cancelled: Watch = { ...watch, state: 'cancelled', endedAt: Date.now() };
	saveWatch(cancelled);
	return cancelled;
}

export function cancelSessionWatches(sessionId: string): void {
	for (const w of activeWatches(sessionId)) cancelWatch(w.id);
}
