import { error } from '@sveltejs/kit';
import type { DeckSession } from '$lib/types';
import { contextFromSession, expandPlaceholders } from '$lib/placeholders';
import { agentSend } from './agents/dispatch';
import { appendEvent } from './claude';
import { updateSession } from './store';
import { issueContextWarning, issuePromptContext, wantsIssueContext } from './issues/prompt';
import { parseImages } from './message-core';

// Expand a template's [tokens]. Rich issue tokens fetch the attached issues'
// context first; when that fetch comes back short, the transcript says so
// before the message goes out.
async function expandMessage(session: DeckSession, text: string): Promise<string> {
	const issues = session.issues ?? (session.issue ? [session.issue] : []);
	const detail = wantsIssueContext(text)
		? await issuePromptContext(session.cwd, issues.map((issue) => ({ issue, sourceId: issue.sourceId ?? '' })))
		: {};
	const warning = issueContextWarning(text, detail);
	if (warning) appendEvent(session.id, { type: 'deck.warning', text: warning, ts: Date.now() });
	return expandPlaceholders(text, { ...contextFromSession(session), ...detail });
}

export async function sendAgentMessage(session: DeckSession, body: Record<string, unknown>): Promise<void> {
	if (typeof body.text !== 'string' && body.text != null) error(400, 'text must be a string');
	const text = (body.text ?? '') as string;
	const images = parseImages(body.images);
	const prompt = body.expand === true ? await expandMessage(session, text) : text;
	if (!prompt.trim() && images.length === 0) error(400, 'empty prompt');
	// The per-turn runners currently accept text only. Never silently drop an attachment.
	if (images.length && session.kind !== 'claude') error(400, 'image attachments require a claude session');
	const meta = typeof body.answersFor === 'string'
		? { answersFor: body.answersFor, answers: Array.isArray(body.answers) ? body.answers : undefined }
		: undefined;
	try {
		updateSession(session.id, { lastActiveAt: Date.now() });
	} catch (err) {
		console.error(`[deck] failed to persist lastActiveAt for ${session.id}:`, err);
	}
	// A turn can outlive an HTTP request. Report later failures in its transcript.
	void agentSend(session, prompt, images.length ? images : undefined, meta).catch((err) => {
		appendEvent(session.id, { type: 'deck.error', text: err instanceof Error ? err.message : 'failed to send message', ts: Date.now() });
	});
}
