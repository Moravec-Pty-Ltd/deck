import type { DeckSession } from '$lib/types';
import { answerText } from './http';
import { pendingAskId, resolveAsk, wasSettled } from './ask';
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

// The ask the client says it is answering (`askId` from the agent API's
// listing, `toolUseId` from the web ask card), if it named one.
export function namedAskId(body: Record<string, unknown>): string | undefined {
	for (const key of ['askId', 'toolUseId']) {
		const v = body[key];
		if (typeof v === 'string' && v) return v;
	}
	return undefined;
}

// Answer a session's blocking ask. Shared by the web and agent answer routes so
// both persist structured picks the same way: the picks are recorded on the
// transcript against the ask's tool_use id (so the card shows them answered on
// reload, from any client), then the pending entry resolves with the text and
// the turn continues. Returns whether anything was waiting. An answer naming an
// ask already settled is turned down: a widget or notification still showing
// an answered question must not answer the session's next one.
export function answerAsk(session: DeckSession, body: Record<string, unknown>): boolean {
	const text = answerText(body);
	const answers = parseAnswers(body.answers);
	const named = namedAskId(body);
	if (named && wasSettled(session.id, named)) return false;
	const askId = named ?? pendingAskId(session.id);
	if (askId && answers) recordAnswer(session.id, askId, answers);
	return resolveAsk(session.id, text);
}
