import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isAgentKind } from '$lib/types';
import { getSession } from '$lib/server/sessions';
import { agentSend, agentInterrupt } from '$lib/server/agents/dispatch';
import type { ImageInput } from '$lib/server/claude';
import { sendKeys, sendRawKey } from '$lib/server/tmux';
import { updateSession } from '$lib/server/store';
import { expandPlaceholders, contextFromSession } from '$lib/placeholders';

const IMAGE_TYPE = /^image\/(png|jpe?g|gif|webp)$/;

// Best-effort recency bump: lastActiveAt is non-critical, so a failed store
// write must never block the actual send (or keystroke) it sits next to.
function anchorRecency(id: string) {
	try {
		updateSession(id, { lastActiveAt: Date.now() });
	} catch (err) {
		console.error(`[deck] failed to persist lastActiveAt for ${id}:`, err);
	}
}

function parseImages(raw: unknown): ImageInput[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.filter(
			(i): i is ImageInput =>
				!!i &&
				typeof i.media_type === 'string' &&
				IMAGE_TYPE.test(i.media_type) &&
				typeof i.data === 'string' &&
				i.data.length < 12_000_000
		)
		.slice(0, 8);
}

export const POST: RequestHandler = async ({ params, request }) => {
	const session = await getSession(params.id);
	if (!session) error(404, 'session not found');

	const body = await request.json();

	if (body.action === 'interrupt' || body.action === 'stop') {
		if (isAgentKind(session.kind)) agentInterrupt(session.id);
		return json({ ok: true });
	}

	const text: string = body.text ?? '';

	if (isAgentKind(session.kind)) {
		const images = parseImages(body.images);
		// Quick messages opt into [token] expansion against the live session; a
		// normally typed message is sent verbatim so literal brackets are untouched.
		const prompt = body.expand === true ? expandPlaceholders(text, contextFromSession(session)) : text;
		if (!prompt.trim() && images.length === 0) error(400, 'empty prompt');
		const meta =
			typeof body.answersFor === 'string'
				? { answersFor: body.answersFor, answers: Array.isArray(body.answers) ? body.answers : undefined }
				: undefined;
		// Anchor recency durably at send time. The hot-path setStatus('running')
		// only updates the in-memory record (the read path derives running live),
		// so without this an abnormal exit before the turn's terminal idle flush
		// would lose this session's place in the recency sort. Once per user
		// message is cheap, unlike the per-message_start churn we removed.
		anchorRecency(session.id);
		// no running guard: a message sent mid-turn is queued (claude) or restarts
		// the turn (per-turn agents)
		agentSend(session, prompt, images.length ? images : undefined, meta);
		return json({ ok: true, status: 'running' });
	}

	if (!session.tmuxName) error(400, 'session has no tmux target');
	if (typeof body.key === 'string' && /^[A-Za-z0-9-]+$/.test(body.key)) {
		await sendRawKey(session.tmuxName, body.key);
	} else {
		await sendKeys(session.tmuxName, text, body.submit !== false);
	}
	if (session.managed) anchorRecency(session.id);
	return json({ ok: true });
};
