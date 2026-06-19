import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { objectBody } from '$lib/server/http';
import { linearMe, linearTeams, linearStates } from '$lib/server/issues/linear';
import {
	clickupMe,
	clickupTeams,
	clickupSpaces,
	clickupFolders,
	clickupLists,
	clickupStatuses
} from '$lib/server/issues/clickup';

type Body = Record<string, unknown>;
type Handler = (apiKey: string, body: Body) => Promise<unknown>;

const s = (v: unknown) => String(v ?? '');

// One handler per (type, action). A flat table keeps the route a lookup rather
// than a nested if-ladder.
const HANDLERS: Record<string, Record<string, Handler>> = {
	linear: {
		me: (k) => linearMe(k),
		teams: (k) => linearTeams(k),
		states: (k, b) => linearStates(k, s(b.teamId))
	},
	clickup: {
		me: (k) => clickupMe(k),
		teams: (k) => clickupTeams(k),
		spaces: (k, b) => clickupSpaces(k, s(b.teamId)),
		folders: (k, b) => clickupFolders(k, s(b.spaceId)),
		lists: (k, b) => clickupLists(k, { folderId: s(b.folderId) || undefined, spaceId: s(b.spaceId) || undefined }),
		statuses: (k, b) => clickupStatuses(k, s(b.listId))
	}
};

async function run(handler: Handler, apiKey: string, body: Body) {
	try {
		return json(await handler(apiKey, body));
	} catch (e) {
		// Surface provider failures (most often a bad key) to the config UI.
		error(400, e instanceof Error ? e.message : 'request failed');
	}
}

// POST /api/issues/meta — config-time lookups while adding a Linear/ClickUp
// source. Takes an as-yet-unsaved apiKey and proxies the provider so the
// add-source UI can cascade (me → teams → states / spaces → folders → lists →
// statuses) before anything is persisted.
export const POST: RequestHandler = async ({ request }) => {
	const body = await objectBody(request);
	const apiKey = s(body.apiKey).trim();
	if (!apiKey) error(400, 'apiKey required');

	const handler = HANDLERS[s(body.type)]?.[s(body.action)];
	if (!handler) error(400, 'unknown type/action');

	return run(handler, apiKey, body);
};
