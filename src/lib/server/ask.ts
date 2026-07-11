import { getStoredSession } from './store';
import { notify } from './push';
import { publishAgentEvent } from './agent-feed';

// One outstanding "ask the user" call per claude session. The MCP `ask` tool
// handler registers a pending entry and awaits it; the UI resolves it when the
// user answers, or it is rejected if the turn is interrupted / the process dies.
interface Pending {
	// kept so /api/agent/asks can list what's blocking without a transcript parse
	questions: AskQuestion[];
	askedAt: number;
	resolve: (text: string) => void;
	reject: (err: Error) => void;
}

export interface AskQuestion {
	question: string;
	header?: string;
	multiSelect?: boolean;
	options: { label: string; description?: string }[];
}

// A pending ask as the agent API lists it. `askId` is set for workflow
// checkpoints (see workflows.ts), absent for MCP asks (answered by text alone).
export interface PendingAsk {
	sessionId: string;
	source: 'mcp' | 'workflow';
	askId?: string;
	questions: AskQuestion[];
	askedAt: number;
}

const g = globalThis as { __deckAsks?: Map<string, Pending> };
const pending = (g.__deckAsks ??= new Map());

export function registerAsk(
	sessionId: string,
	questions: AskQuestion[],
	signal?: AbortSignal
): Promise<string> {
	// Replace any earlier pending ask for this session (shouldn't normally happen).
	pending.get(sessionId)?.reject(new Error('superseded'));

	const title = getStoredSession(sessionId)?.title ?? 'session';
	notify({
		title: `Needs your answer · ${title}`,
		body: questions[0]?.question ?? 'Claude is asking a question',
		tag: sessionId,
		url: `/s/${sessionId}`
	});
	publishAgentEvent(sessionId, 'awaiting-input', { awaitingInput: true, source: 'mcp', questions });

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
		questions: p.questions,
		askedAt: p.askedAt
	}));
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
