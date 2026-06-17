import { getStoredSession } from './store';
import { notify } from './push';

// One outstanding "ask the user" call per claude session. The MCP `ask` tool
// handler registers a pending entry and awaits it; the UI resolves it when the
// user answers, or it is rejected if the turn is interrupted / the process dies.
interface Pending {
	resolve: (text: string) => void;
	reject: (err: Error) => void;
}

export interface AskQuestion {
	question: string;
	header?: string;
	multiSelect?: boolean;
	options: { label: string; description?: string }[];
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

	return new Promise<string>((resolve, reject) => {
		const entry: Pending = {
			resolve: (text) => {
				if (pending.get(sessionId) === entry) pending.delete(sessionId);
				resolve(text);
			},
			reject: (err) => {
				if (pending.get(sessionId) === entry) pending.delete(sessionId);
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
