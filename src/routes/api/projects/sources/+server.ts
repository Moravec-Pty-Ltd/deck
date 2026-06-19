import { json, error } from '@sveltejs/kit';
import crypto from 'node:crypto';
import type { RequestHandler } from './$types';
import { objectBody } from '$lib/server/http';
import { listProjects, addSource, removeSource, setSecret } from '$lib/server/store';
import type { IssueSource } from '$lib/types';

type Body = Record<string, unknown>;
type Built = { source: IssueSource; apiKey?: string };

const str = (v: unknown) => String(v ?? '').trim();
const strArray = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
const need = (ok: boolean, msg: string) => {
	if (!ok) error(400, msg);
};

function githubSource(id: string, b: Body): Built {
	const owner = str(b.owner);
	const repo = str(b.repo);
	need(!!owner && !!repo, 'owner and repo are required');
	return { source: { id, type: 'github', owner, repo } };
}

function linearSource(id: string, b: Body): Built {
	const apiKey = str(b.apiKey);
	const teamId = str(b.teamId);
	need(!!apiKey && !!teamId, 'apiKey and teamId are required');
	return {
		source: { id, type: 'linear', teamId, teamName: str(b.teamName), assigneeEmail: str(b.assigneeEmail), stateIds: strArray(b.stateIds) },
		apiKey
	};
}

function clickupSource(id: string, b: Body): Built {
	const f = { apiKey: str(b.apiKey), teamId: str(b.teamId), spaceId: str(b.spaceId), listId: str(b.listId), assigneeUserId: Number(b.assigneeUserId) };
	need(
		[f.apiKey, f.teamId, f.spaceId, f.listId].every(Boolean) && Number.isFinite(f.assigneeUserId),
		'apiKey, teamId, spaceId, listId and assigneeUserId are required'
	);
	const folderId = str(b.folderId);
	return {
		source: {
			id,
			type: 'clickup',
			teamId: f.teamId,
			teamName: str(b.teamName),
			spaceId: f.spaceId,
			spaceName: str(b.spaceName),
			folderId: folderId || undefined,
			folderName: folderId ? str(b.folderName) : undefined,
			listId: f.listId,
			listName: str(b.listName),
			statuses: strArray(b.statuses),
			assigneeUserId: f.assigneeUserId
		},
		apiKey: f.apiKey
	};
}

const BUILDERS: Record<string, (id: string, b: Body) => Built> = {
	github: githubSource,
	linear: linearSource,
	clickup: clickupSource
};

// Validate the per-type body and return the source to persist plus, for keyed
// providers, the apiKey to stash in secrets.json. Throws a 400 on bad input.
function buildSource(id: string, body: Body): Built {
	const builder = BUILDERS[str(body.type)];
	if (!builder) error(400, 'unknown source type');
	return builder(id, body);
}

// POST /api/projects/sources — add a source to a project. Generates the id,
// stashes any apiKey in secrets.json, and stores the (secret-free) source.
export const POST: RequestHandler = async ({ request }) => {
	const body = await objectBody(request);
	const path = str(body.projectPath);
	if (!listProjects().some((p) => p.path === path)) error(404, 'project not found');

	const id = crypto.randomUUID();
	const { source, apiKey } = buildSource(id, body);
	if (apiKey) setSecret(id, apiKey);
	addSource(path, source);
	return json(source, { status: 201 });
};

// DELETE /api/projects/sources?project=<path>&id=<sourceId> — drops the source
// and its stored secret.
export const DELETE: RequestHandler = async ({ url }) => {
	const path = url.searchParams.get('project');
	const id = url.searchParams.get('id');
	if (!path || !id) error(400, 'project and id required');
	removeSource(path, id);
	return json({ ok: true });
};
