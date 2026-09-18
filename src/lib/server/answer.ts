import type { DeckSession } from '$lib/types';
import { answerText } from './http';
import { pendingAskId, resolveAsk } from './ask';
import { recordAnswer } from './claude';

// One structured pick per question, as the ask card posts it and the transcript
// marker stores it (see recordAnswer / transcript-index answerIn).
export interface StructuredAnswer {
	header: string;
	labels: string[];
}

// The picks an answer body carries, or undefined when it answers by text alone
// (or the shape is unusable). Tolerant: a malformed entry is dropped, never a 400,
// since the text answer is what unblocks the turn.
export function parseAnswers(raw: unknown): StructuredAnswer[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const answers: StructuredAnswer[] = [];
	for (const item of raw) {
		const o = (item ?? {}) as Record<string, unknown>;
		if (typeof o.header !== 'string' || !Array.isArray(o.labels)) continue;
		answers.push({ header: o.header, labels: o.labels.filter((l): l is string => typeof l === 'string') });
	}
	return answers;
}

// The ask the answer is for: the id the client named (`askId` from the agent
// API's listing, `toolUseId` from the web ask card), else the session's pending
// ask when the server knows it.
function askIdFor(sessionId: string, body: Record<string, unknown>): string | undefined {
	for (const key of ['askId', 'toolUseId']) {
		const v = body[key];
		if (typeof v === 'string' && v) return v;
	}
	return pendingAskId(sessionId);
}

// Answer a session's blocking ask. Shared by the web and agent answer routes so
// both persist structured picks the same way: the picks are recorded on the
// transcript against the ask's tool_use id (so the card shows them answered on
// reload, from any client), then the pending entry resolves with the text and
// the turn continues. Returns whether anything was waiting.
export function answerAsk(session: DeckSession, body: Record<string, unknown>): boolean {
	const text = answerText(body);
	const answers = parseAnswers(body.answers);
	const askId = askIdFor(session.id, body);
	if (askId && answers) recordAnswer(session.id, askId, answers);
	return resolveAsk(session.id, text);
}
