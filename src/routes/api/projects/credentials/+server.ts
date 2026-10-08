import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { IssueSourceType } from '$lib/types';
import { listProjects } from '$lib/server/store';
import { credentialsFor, listCredentials } from '$lib/server/credentials-core';

// GET /api/projects/credentials[?type=linear] — the issue-source API keys
// already saved, so adding a source to a second project can point at one
// instead of asking for it again (issue #237).
//
// Derived from the sources that name each key, not from a store of its own, and
// it carries no key value. Nothing here is a secret: a label, which provider it
// is for, and which projects already use it.
export const GET: RequestHandler = async ({ url }) => {
	const type = url.searchParams.get('type') as IssueSourceType | null;
	const projects = listProjects();
	return json(type ? credentialsFor(projects, type) : listCredentials(projects));
};
