// Pure projection of a session's raw transcript events into readable turn output
// for the agent API (issue #144): the recent user/assistant messages and the last
// assistant reply. Node-free and defensive — transcript lines are heterogeneous
// (assistant / user / result / deck.* markers, occasionally an unreadable
// placeholder), so every shape is guarded. The IO (reading the tail) lives in
// server/transcript.ts.

export interface TranscriptMessage {
	role: 'assistant' | 'user';
	text: string;
}

export interface ProjectedTranscript {
	messages: TranscriptMessage[];
	// The session's most recent assistant reply — what an orchestrator reads to see
	// what the session actually said. null when it hasn't produced any text yet.
	lastResult: string | null;
}

// Cap the projected message list so a long turn's tail stays a bounded payload.
const MAX_MESSAGES = 40;

// Concatenate the text of an assistant/user message's content, which is either a
// bare string or an array of typed blocks. Tool-call / tool-result blocks carry no
// prose and contribute nothing.
function textFromContent(content: unknown): string {
	if (typeof content === 'string') return content.trim();
	if (!Array.isArray(content)) return '';
	const parts: string[] = [];
	for (const block of content) {
		const b = block as { type?: unknown; text?: unknown };
		if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text);
	}
	return parts.join('').trim();
}

// One transcript event → a readable message, or null when it carries no
// user/assistant prose (tool calls, tool results, deck.* markers, result footers).
function messageFrom(event: unknown): TranscriptMessage | null {
	const ev = event as { type?: unknown; message?: { content?: unknown } };
	if (ev?.type === 'assistant') {
		const text = textFromContent(ev.message?.content);
		return text ? { role: 'assistant', text } : null;
	}
	if (ev?.type === 'user') {
		// A user event whose content is only a tool_result isn't a human/orchestrator
		// message; textFromContent returns '' for it, so it drops out.
		const text = textFromContent(ev.message?.content);
		return text ? { role: 'user', text } : null;
	}
	return null;
}

export function projectTranscript(events: unknown[]): ProjectedTranscript {
	const messages: TranscriptMessage[] = [];
	let lastResult: string | null = null;
	for (const event of events) {
		const msg = messageFrom(event);
		if (!msg) continue;
		messages.push(msg);
		if (msg.role === 'assistant') lastResult = msg.text;
	}
	return { messages: messages.slice(-MAX_MESSAGES), lastResult };
}
