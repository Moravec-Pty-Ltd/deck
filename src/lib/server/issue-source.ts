// Issue-source handlers, each shared verbatim by a browser route and its agent
// API twin so the two cannot drift: adding and removing a project's sources,
// the provider lookups the add-source form cascades through, and the saved
// keys a new source can reuse. API keys are write-only here: one goes in on a
// POST and is stashed in the keyring, and no response ever carries one.
import { error, json } from '@sveltejs/kit';
import crypto from 'node:crypto';
import type { IssueSourceType } from '$lib/types';
import { objectBody } from './http';
import { listProjects, addSource, removeSource, setSecret } from './store';
import { credentialForSource, resolveApiKey } from './credentials';
import { credentialsFor, listCredentials } from './credentials-core';
import { buildSource, withoutKey, type SourceBody } from './issue-source-core';
import { linearMe, linearTeams, linearStates } from './issues/linear';
import { clickupMe, clickupTeams, clickupSpaces, clickupFolders, clickupLists, clickupStatuses } from './issues/clickup';

interface RouteEvent {
	url: URL;
	request: Request;
}

const s = (v: unknown) => String(v ?? '').trim();

// Add a source to a project. Generates the source id, stashes a supplied apiKey
// under its credential id, and stores the (secret-free) source. A body naming a
// saved `credentialId` instead reuses that key: nothing is written, and the
// source points at it.
export async function addSourceRoute({ request }: Pick<RouteEvent, 'request'>): Promise<Response> {
	const body = await objectBody(request);
	const path = s(body.projectPath);
	if (!listProjects().some((p) => p.path === path)) error(404, 'project not found');

	const { source, secret } = buildSource(crypto.randomUUID(), body, credentialForSource);
	if (secret) setSecret(secret.credentialId, secret.apiKey);
	addSource(path, source);
	return json(source, { status: 201 });
}

// ?project=<path>&id=<sourceId>: drops the source, and its stored key only if
// no other source still points at it (issue #237).
export async function removeSourceRoute({ url }: Pick<RouteEvent, 'url'>): Promise<Response> {
	const path = url.searchParams.get('project');
	const id = url.searchParams.get('id');
	if (!path || !id) error(400, 'project and id required');
	if (!removeSource(path, id)) error(404, 'project not found');
	return json({ ok: true });
}

// The saved keys (labels only, never a key value), optionally ?type= filtered.
export async function credentialsRoute({ url }: Pick<RouteEvent, 'url'>): Promise<Response> {
	const type = url.searchParams.get('type') as IssueSourceType | null;
	const projects = listProjects();
	return json(type ? credentialsFor(projects, type) : listCredentials(projects));
}

type Lookup = (apiKey: string, body: SourceBody) => Promise<unknown>;

// One handler per (type, action), so the route is a lookup rather than a
// nested if-ladder.
const LOOKUPS: Record<string, Record<string, Lookup>> = {
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

async function runLookup(lookup: Lookup, apiKey: string, body: SourceBody): Promise<Response> {
	try {
		return json(await lookup(apiKey, body));
	} catch (e) {
		// Surface provider failures (most often a bad key) to the config form.
		error(400, withoutKey(e instanceof Error ? e.message : 'request failed', apiKey));
	}
}

// Config-time lookups while adding a Linear/ClickUp source. Proxies the provider
// so the form can cascade (me, teams, states / spaces, folders, lists, statuses)
// before anything is persisted, with either an as-yet-unsaved apiKey or a saved
// credentialId.
export async function sourceLookupRoute({ request }: Pick<RouteEvent, 'request'>): Promise<Response> {
	const body = await objectBody(request);
	const lookup = LOOKUPS[s(body.type)]?.[s(body.action)];
	if (!lookup) error(400, 'unknown type/action');
	return runLookup(lookup, resolveApiKey(body), body);
}
