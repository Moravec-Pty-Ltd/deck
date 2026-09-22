// The operator drawer's pure parts: the log it shows and how a reply, an
// announcement, or a failure lands on it. Node-free and tested.

export interface OperatorLogEntry {
	id: number;
	role: 'user' | 'operator';
	text: string;
	at: number;
	// Tools the operator ran for this reply, as "tool: result" lines.
	actions?: string[];
	// True for something the operator said on its own.
	announcement?: boolean;
	error?: boolean;
}

export interface OperatorReplyBody {
	text: string;
	actions: { tool: string; args: Record<string, unknown>; result: string }[];
}

interface HistoryTurn {
	role: 'user' | 'assistant' | 'tool';
	content: string;
	at: number;
}

let nextId = 1;

function entry(role: OperatorLogEntry['role'], text: string, at: number, extra: Partial<OperatorLogEntry> = {}): OperatorLogEntry {
	return { id: nextId++, role, text, at, ...extra };
}

// The server's history as log entries; assistant turns that only carried tool
// calls have no text and are left out.
export function fromHistory(turns: HistoryTurn[]): OperatorLogEntry[] {
	return turns
		.filter((t) => t.role !== 'tool' && t.content.trim())
		.map((t) => entry(t.role === 'user' ? 'user' : 'operator', t.content, t.at));
}

export function userEntry(text: string, at: number): OperatorLogEntry {
	return entry('user', text, at);
}

export function replyEntry(reply: OperatorReplyBody, at: number): OperatorLogEntry {
	const actions = reply.actions.map((a) => `${a.tool}: ${a.result.split('\n')[0].slice(0, 120)}`);
	return entry('operator', reply.text, at, actions.length ? { actions } : {});
}

export function announcementEntry(text: string, at: number): OperatorLogEntry {
	return entry('operator', text, at, { announcement: true });
}

export function errorEntry(message: string, at: number): OperatorLogEntry {
	return entry('operator', message, at, { error: true });
}

// What to tell the user when the operator call fails, from the HTTP status.
export function failureText(status: number, detail: string): string {
	if (status === 503) return 'No operator model is configured. Add an operator block to settings.json.';
	if (status === 502) return `The operator model is not answering (${detail || 'unreachable'}).`;
	return detail || `The operator failed (${status}).`;
}
