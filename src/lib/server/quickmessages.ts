import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { QuickMessage } from '$lib/types';
import { readJson, writeJson } from './config';

const FILE = 'quick-messages.json';
// A personal canned-message list stays small; cap so a bad PUT can't grow the
// stored file unbounded.
const MAX = 200;

const messageSchema = z.object({
	id: z.string().trim().min(1),
	label: z.string().trim().optional(),
	text: z.string().trim().min(1),
	projectId: z.string().trim().optional()
});
const listSchema = z.array(messageSchema).max(MAX);

// Drop a label that trimmed to empty so the menu falls back to the text, and a
// blank projectId so the message reads as global.
function normalise(m: z.infer<typeof messageSchema>): QuickMessage {
	const out: QuickMessage = { id: m.id, text: m.text };
	if (m.label) out.label = m.label;
	if (m.projectId) out.projectId = m.projectId;
	return out;
}

// Read the stored list, tolerating a missing or corrupt file (-> []).
export function listQuickMessages(): QuickMessage[] {
	const parsed = listSchema.safeParse(readJson<unknown>(FILE, []));
	return parsed.success ? parsed.data.map(normalise) : [];
}

// Validate + normalise, then replace the whole list. Throws on a schema mismatch
// so the API can return a 400.
export function saveQuickMessages(raw: unknown): QuickMessage[] {
	const list = listSchema.parse(raw).map(normalise);
	writeJson(FILE, list);
	return list;
}

// Handlers shared by /api/quick-messages and /api/agent/quick-messages. PUT
// replaces the whole list; a schema mismatch is a 400, not a 500.
export function quickMessagesGetRoute(): Response {
	return json(listQuickMessages());
}

export async function quickMessagesPutRoute({ request }: { request: Request }): Promise<Response> {
	try {
		return json(saveQuickMessages(await request.json()));
	} catch (e) {
		error(400, e instanceof Error ? e.message : 'invalid quick messages');
	}
}
