// Building the issue source a POST describes, kept free of the store and the
// keyring so the per-type validation unit-tests on its own. The route
// (issue-source.ts) supplies how a keyed source resolves its credential.
import { error } from '@sveltejs/kit';
import type { IssueSource } from '$lib/types';

export type SourceBody = Record<string, unknown>;

// Which credential a keyed source authenticates with; `apiKey` is set only when
// a fresh key was supplied and so has to be stored.
export type CredentialPick = { credentialId: string; apiKey?: string };
export type PickCredential = (body: SourceBody) => CredentialPick;

// `secret` is the key to stash, set only when one was supplied; a source reusing
// a saved credential has nothing to write, because the key is already stored.
// The source itself never carries the key, so it is safe to return as-is.
export type BuiltSource = { source: IssueSource; secret?: { credentialId: string; apiKey: string } };

const str = (v: unknown) => String(v ?? '').trim();
const strArray = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
const need = (ok: boolean, msg: string) => {
	if (!ok) error(400, msg);
};

function keyed(b: SourceBody, pick: PickCredential, build: (credentialId: string) => IssueSource): BuiltSource {
	const { credentialId, apiKey } = pick(b);
	return {
		source: build(credentialId),
		secret: apiKey ? { credentialId, apiKey } : undefined
	};
}

function githubSource(id: string, b: SourceBody): BuiltSource {
	const owner = str(b.owner);
	const repo = str(b.repo);
	need(!!owner && !!repo, 'owner and repo are required');
	return { source: { id, type: 'github', owner, repo } };
}

function linearSource(id: string, b: SourceBody, pick: PickCredential): BuiltSource {
	const teamId = str(b.teamId);
	need(!!teamId, 'teamId is required');
	return keyed(b, pick, (credentialId) => ({
		id,
		type: 'linear',
		teamId,
		teamName: str(b.teamName),
		assigneeEmail: str(b.assigneeEmail),
		stateIds: strArray(b.stateIds),
		credentialId
	}));
}

function clickupSource(id: string, b: SourceBody, pick: PickCredential): BuiltSource {
	const f = { teamId: str(b.teamId), spaceId: str(b.spaceId), listId: str(b.listId), assigneeUserId: Number(b.assigneeUserId) };
	need(
		[f.teamId, f.spaceId, f.listId].every(Boolean) && Number.isFinite(f.assigneeUserId),
		'teamId, spaceId, listId and assigneeUserId are required'
	);
	const folderId = str(b.folderId);
	return keyed(b, pick, (credentialId) => ({
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
		assigneeUserId: f.assigneeUserId,
		// Stored so a saved key can be offered under a name rather than a number.
		assigneeName: str(b.assigneeName) || undefined,
		credentialId
	}));
}

const BUILDERS: Record<string, (id: string, b: SourceBody, pick: PickCredential) => BuiltSource> = {
	github: githubSource,
	linear: linearSource,
	clickup: clickupSource
};

// Validate the per-type body and return the source to persist plus, when a key
// was supplied, the credential to stash it under. Throws a 400 on bad input.
export function buildSource(id: string, body: SourceBody, pick: PickCredential): BuiltSource {
	const builder = BUILDERS[str(body.type)];
	if (!builder) error(400, 'unknown source type');
	return builder(id, body, pick);
}

// A provider's error text with the key cut out. Linear and ClickUp quote their
// response body back, and nothing guarantees that never includes the request's
// credentials; this message goes to whoever made the lookup.
export function withoutKey(message: string, apiKey: string): string {
	return apiKey ? message.split(apiKey).join('<redacted>') : message;
}
