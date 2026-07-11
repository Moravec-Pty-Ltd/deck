import { error, json } from '@sveltejs/kit';
import { isAgentKind, type DeckSession } from '$lib/types';
import { getSession, deleteSession } from './sessions';

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === 'object' && !Array.isArray(v);
}

// Parse a JSON request body, asserting it is a plain object. Replies 400 on a
// missing, malformed, null, primitive, or array body so handlers can read
// fields without guarding each access.
export async function objectBody(request: Request): Promise<Record<string, unknown>> {
	const body = await request.json().catch(() => null);
	if (!isPlainObject(body)) error(400, 'invalid request body');
	return body;
}

// The agent session a per-session action route targets, or a 404. Shells (and
// unknown ids) have no asks, workflows, or turns to act on.
export async function agentSessionOr404(id: string): Promise<DeckSession> {
	const session = await getSession(id);
	if (!session || !isAgentKind(session.kind)) error(404, 'session not found');
	return session;
}

// Session-teardown flags, from the JSON body or the query-string fallback
// (?worktree=1&branch=1). A non-object JSON body (null, array, string) falls
// back to the query flags rather than reaching deleteSession and throwing.
async function deleteSessionOpts(
	request: Request,
	url: URL
): Promise<{ deleteWorktree?: boolean; deleteBranch?: boolean }> {
	const body = await request.json().catch(() => null);
	if (isPlainObject(body)) {
		return { deleteWorktree: body.deleteWorktree === true, deleteBranch: body.deleteBranch === true };
	}
	return {
		deleteWorktree: url.searchParams.get('worktree') === '1',
		deleteBranch: url.searchParams.get('branch') === '1'
	};
}

// The DELETE handler shared verbatim by /api/sessions/[id] and
// /api/agent/sessions/[id] (teardown with optional worktree/branch removal).
export async function deleteSessionRoute(event: {
	params: Partial<Record<string, string>>;
	request: Request;
	url: URL;
}): Promise<Response> {
	await deleteSession(event.params.id!, await deleteSessionOpts(event.request, event.url));
	return json({ ok: true });
}

// Run a gh PR action and shape the response: gh surfaces a real failure
// (own-PR approve, dirty merge) as a thrown error; turn it into a 400 carrying
// gh's message so the caller can show it inline.
export async function prActionResponse(call: () => Promise<unknown>): Promise<Response> {
	try {
		return json({ pr: (await call()) ?? null });
	} catch (e) {
		error(400, e instanceof Error ? e.message : 'failed to run PR action');
	}
}

// The non-empty trimmed `text` an answer body must carry, or a 400.
export function answerText(body: Record<string, unknown>): string {
	const text = String(body.text ?? '').trim();
	if (!text) error(400, 'empty answer');
	return text;
}
