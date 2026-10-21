import type { FeedResponse } from '$lib/session-feed-core';
import type { SessionView } from '$lib/session-view';

// The web inbox (/inbox): what GET /api/agent/asks lists, a session's MCP ask or
// a blocked workflow run, turned into rows to render and answer. Node-free so
// the ordering, labels and answer requests test without a server.

export interface InboxQuestion {
	question: string;
	header?: string;
	multiSelect?: boolean;
	options: { label: string; description?: string }[];
}

export type InboxAsk =
	| { source: 'mcp'; sessionId: string; askId?: string; questions: InboxQuestion[]; askedAt: number }
	| { source: 'run'; runId: string; sessionId?: string; questions: InboxQuestion[]; askedAt: number };

export interface AnswerPick {
	header: string;
	labels: string[];
}

export interface InboxRow {
	// Changes when a new ask replaces an old one, so the card remounts empty.
	key: string;
	ask: InboxAsk;
	title: string;
	subtitle: string;
	href: string;
}

export interface InboxGroup {
	id: 'sessions' | 'runs';
	label: string;
	rows: InboxRow[];
}

function basename(path: string): string {
	return path.split('/').filter(Boolean).pop() ?? path;
}

function sessionTitle(id: string, sessions: SessionView[]): string {
	const s = sessions.find((x) => x.id === id);
	if (!s) return id;
	return s.title || basename(s.cwd) || id;
}

export function toRow(ask: InboxAsk, sessions: SessionView[]): InboxRow {
	if (ask.source === 'run') {
		return {
			key: `run:${ask.runId}:${ask.askedAt}`,
			ask,
			title: ask.questions[0]?.header || 'Workflow run',
			subtitle: 'Workflow run',
			href: `/runs/${encodeURIComponent(ask.runId)}`
		};
	}
	return {
		key: `mcp:${ask.sessionId}:${ask.askId ?? ''}:${ask.askedAt}`,
		ask,
		title: sessionTitle(ask.sessionId, sessions),
		subtitle: 'Session',
		href: `/s/${encodeURIComponent(ask.sessionId)}`
	};
}

// Session questions first, then blocked runs; within each the longest waiting
// leads. Empty groups are dropped.
export function inboxGroups(asks: InboxAsk[], sessions: SessionView[]): InboxGroup[] {
	const rows = [...asks].sort((a, b) => a.askedAt - b.askedAt).map((a) => toRow(a, sessions));
	const groups: InboxGroup[] = [
		{ id: 'sessions', label: 'Questions', rows: rows.filter((r) => r.ask.source === 'mcp') },
		{ id: 'runs', label: 'Blocked runs', rows: rows.filter((r) => r.ask.source === 'run') }
	];
	return groups.filter((g) => g.rows.length);
}

// The card's view of an ask: AskQuestion reads the tool_use block shape. A
// run's header is its title, already on the row, so the card drops it.
export function askBlock(ask: InboxAsk): { input: { questions: InboxQuestion[] } } {
	const questions = ask.source === 'run' ? ask.questions.map(({ header: _, ...q }) => q) : ask.questions;
	return { input: { questions } };
}

// Where an answer goes. A session's ask carries the picks so the transcript
// shows it answered; a run takes the answer as plain text (it has no options,
// so the picks are only what was typed).
export function answerRequest(
	ask: InboxAsk,
	text: string,
	answers: AnswerPick[]
): { url: string; body: Record<string, unknown> } {
	if (ask.source === 'run') {
		const typed = answers.flatMap((a) => a.labels).join(', ');
		return { url: `/api/agent/runs/${encodeURIComponent(ask.runId)}/answer`, body: { text: typed || text } };
	}
	const body: Record<string, unknown> = { text, answers };
	if (ask.askId) body.askId = ask.askId;
	return { url: `/api/agent/sessions/${encodeURIComponent(ask.sessionId)}/answer`, body };
}

// Event types that can add or clear an inbox entry.
const INBOX_EVENTS: ReadonlySet<string> = new Set(['awaiting-input', 'run-updated', 'run-deleted', 'session-deleted']);

// Whether a feed response may have changed what the inbox lists. A snapshot
// (bootstrap, a gap, a return to the tab) always may.
export function touchesInbox(res: FeedResponse): boolean {
	if ('snapshot' in res) return true;
	return res.events.some((e) => INBOX_EVENTS.has(e.type));
}
