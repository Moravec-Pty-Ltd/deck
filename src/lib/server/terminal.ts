import { error, json } from '@sveltejs/kit';
import type { DeckSession } from '$lib/types';
import { objectBody, sessionOr404 } from './http';
import { stableSnapshot, snapshotTag, sendKeys, sendRawKey } from './tmux';
import { updateSession } from './store';
import { DEMO, demoTerminalText } from './demo';
import { parseSnapshotQuery, parseTerminalInput } from './terminal-core';

// A shell session's tmux pane, read and typed into. The browser's /snapshot and
// the agent API's /terminal GET share terminalSnapshotRoute; the browser's /send
// (shell branch) and the agent /terminal POST share driveTerminal.

interface SessionEvent {
	params: Partial<Record<string, string>>;
	url: URL;
	request: Request;
}

const DEAD = { text: '(session is dead)', dead: true };

function tmuxTarget(session: DeckSession): string {
	if (session.kind !== 'shell' || !session.tmuxName) error(400, 'not a shell session');
	return session.tmuxName;
}

// Best-effort recency bump: lastActiveAt is non-critical, so a failed store
// write must never block the keystroke it sits next to.
function anchorRecency(id: string) {
	try {
		updateSession(id, { lastActiveAt: Date.now() });
	} catch (err) {
		console.error(`[deck] failed to persist lastActiveAt for ${id}:`, err);
	}
}

// { text, cleared, dead, h }, or { unchanged: true, h } when ?h= matches the
// current pane so a poller skips re-rendering.
export async function terminalSnapshotRoute({ params, url }: Pick<SessionEvent, 'params' | 'url'>): Promise<Response> {
	const session = await sessionOr404(params.id!);
	if (DEMO) return json({ text: demoTerminalText(session.id), cleared: false, dead: false });
	const target = tmuxTarget(session);
	if (session.status === 'dead') return json(DEAD);
	const { lines, h: prev } = parseSnapshotQuery(url.searchParams);
	try {
		const { text, cleared } = await stableSnapshot(target, lines);
		const h = snapshotTag(text, cleared);
		if (prev === h) return json({ unchanged: true, h });
		return json({ text, cleared, dead: false, h });
	} catch {
		return json(DEAD);
	}
}

// Type text or press one key in a shell session's pane. Demo mode has no real
// panes behind its sessions, so input goes nowhere.
export async function driveTerminal(session: DeckSession, body: Record<string, unknown>): Promise<void> {
	const target = tmuxTarget(session);
	const input = parseTerminalInput(body);
	if ('error' in input) error(400, input.error);
	if (DEMO) return;
	if ('key' in input) await sendRawKey(target, input.key);
	else await sendKeys(target, input.text, input.submit);
	if (session.managed) anchorRecency(session.id);
}

export async function terminalInputRoute({ params, request }: Pick<SessionEvent, 'params' | 'request'>): Promise<Response> {
	const session = await sessionOr404(params.id!);
	await driveTerminal(session, await objectBody(request));
	return json({ ok: true });
}
