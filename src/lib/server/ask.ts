import { getStoredSession } from './store';
import { notify, type NotifyPayload } from './push';
import { publishAgentEvent } from './agent-feed';
import { latestAskToolUseId } from './transcript';
import { ASK_ACTION_SLOTS, askNotificationBody } from './apns-core';

// One outstanding "ask the user" call per claude session. The MCP `ask` tool
// handler registers a pending entry and awaits it; the UI resolves it when the
// user answers, or it is rejected if the turn is interrupted / the process dies.
interface Pending {
	// kept so /api/agent/asks can list what's blocking without a transcript parse
	questions: AskQuestion[];
	askedAt: number;
	// The tool_use id of the ask call, once the transcript lookup lands. Lets an
	// answer carry structured picks that persist against the call (recordAnswer).
	askId?: string;
	resolve: (text: string) => void;
	reject: (err: Error) => void;
}

export interface AskQuestion {
	question: string;
	header?: string;
	multiSelect?: boolean;
	options: { label: string; description?: string }[];
}

// A pending ask as the agent API lists it: the MCP `ask` tool, answered by text
// (optionally with the structured picks, keyed by `askId`).
export interface PendingAsk {
	sessionId: string;
	source: 'mcp';
	askId?: string;
	questions: AskQuestion[];
	askedAt: number;
}

const g = globalThis as { __deckAsks?: Map<string, Pending> };
const pending = (g.__deckAsks ??= new Map());

// Announce the ask on the agent feed and to devices once its tool_use id is
// known (or the lookup gave up), unless the ask was already settled or
// replaced meanwhile. The notification carries the first question's options
// so a phone can answer it from the notification's actions.
async function announce(sessionId: string, entry: Pending): Promise<void> {
	const askId = await latestAskToolUseId(sessionId).catch(() => null);
	if (pending.get(sessionId) !== entry) return;
	if (askId) entry.askId = askId;
	publishAgentEvent(sessionId, 'awaiting-input', {
		awaitingInput: true,
		source: 'mcp',
		...(askId ? { askId } : {}),
		questions: entry.questions
	});
	notify(askNotification(sessionId, entry.questions, askId ?? undefined));
}

// The push for a new ask: the first question and its numbered options in the
// body, and the ask itself for a client's answer actions.
function askNotification(sessionId: string, questions: AskQuestion[], askId: string | undefined) {
	const first = questions[0];
	const options = (first?.options ?? []).map((o) => o.label).slice(0, ASK_ACTION_SLOTS);
	const title = getStoredSession(sessionId)?.title ?? 'session';
	const ask: NotifyPayload['ask'] = { sessionId, options, questions: questions.length };
	if (askId) ask.askId = askId;
	if (first?.header) ask.header = first.header;
	return {
		title: `Needs your answer · ${title}`,
		body: first ? askNotificationBody(first.question, options) : 'Claude is asking a question',
		tag: sessionId,
		url: `/s/${sessionId}`,
		ask
	};
}

export function registerAsk(
	sessionId: string,
	questions: AskQuestion[],
	signal?: AbortSignal
): Promise<string> {
	// Replace any earlier pending ask for this session (shouldn't normally happen).
	pending.get(sessionId)?.reject(new Error('superseded'));

	return new Promise<string>((resolve, reject) => {
		const settle = () => {
			if (pending.get(sessionId) !== entry) return false;
			pending.delete(sessionId);
			publishAgentEvent(sessionId, 'awaiting-input', { awaitingInput: false, source: 'mcp' });
			return true;
		};
		const entry: Pending = {
			questions,
			askedAt: Date.now(),
			resolve: (text) => {
				settle();
				resolve(text);
			},
			reject: (err) => {
				settle();
				reject(err);
			}
		};
		pending.set(sessionId, entry);
		void announce(sessionId, entry);
		if (signal) {
			if (signal.aborted) entry.reject(new Error('aborted'));
			else signal.addEventListener('abort', () => entry.reject(new Error('aborted')), { once: true });
		}
	});
}

// Whether a session is currently blocked on an ask. Surfaced on /api/sessions as
// `awaitingInput` so the sidebar can bucket it under "Needs attention" (issue #48).
export function hasPendingAsk(id: string): boolean {
	return pending.has(id);
}

// Every session's pending MCP ask, for the agent API's needs-attention listing.
export function listPendingAsks(): PendingAsk[] {
	return [...pending.entries()].map(([sessionId, p]) => ({
		sessionId,
		source: 'mcp',
		...(p.askId ? { askId: p.askId } : {}),
		questions: p.questions,
		askedAt: p.askedAt
	}));
}

// The tool_use id of a session's pending ask, when known.
export function pendingAskId(sessionId: string): string | undefined {
	return pending.get(sessionId)?.askId;
}

// Resolve the pending ask for a session with the user's answer text. Returns
// false if nothing was waiting (e.g. a stale UI click).
export function resolveAsk(sessionId: string, text: string): boolean {
	const entry = pending.get(sessionId);
	if (!entry) return false;
	entry.resolve(text);
	return true;
}

export function rejectAsk(sessionId: string, reason = 'cancelled'): void {
	pending.get(sessionId)?.reject(new Error(reason));
}
