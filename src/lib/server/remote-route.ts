import { error, json } from '@sveltejs/kit';
import { objectBody } from './http';
import { parseFingerprints, parseSecret } from '$lib/remote-core';
import {
	acceptHostKeys,
	hostKeyStatus,
	readRemoteSecret,
	remoteProject,
	removeRemoteSecret,
	saveRemoteSecret,
	scanHostKeys
} from './remote';

// A remote project's secret and host key (issue #410), shared by the web and
// the native apps under /api/agent/projects/remote. The secret is write-only:
// a response only ever says whether one is saved.

function projectOr4xx(path: unknown) {
	if (typeof path !== 'string' || !path) error(400, 'path required');
	const project = remoteProject(path);
	if (!project) error(404, 'no remote project at that path');
	return project;
}

export async function remoteStatusRoute({ url }: { url: URL }): Promise<Response> {
	const project = projectOr4xx(url.searchParams.get('path'));
	return json({ secretSaved: !!readRemoteSecret(project.path), hostKey: await hostKeyStatus(project.remote) });
}

export async function putSecretRoute({ request }: { request: Request }): Promise<Response> {
	const body = await objectBody(request);
	const project = projectOr4xx(body.path);
	const secret = parseSecret(body.secret);
	if (!secret) error(400, 'secret must be a single line of text');
	saveRemoteSecret(project.path, secret);
	return json({ secretSaved: true });
}

export function deleteSecretRoute({ url }: { url: URL }): Response {
	const project = projectOr4xx(url.searchParams.get('path'));
	removeRemoteSecret(project.path);
	return json({ secretSaved: false });
}

export async function scanHostKeyRoute({ url }: { url: URL }): Promise<Response> {
	const project = projectOr4xx(url.searchParams.get('path'));
	try {
		return json({ keys: await scanHostKeys(project.remote) });
	} catch (e) {
		error(502, e instanceof Error ? e.message : 'could not read the host key');
	}
}

export async function acceptHostKeyRoute({ request }: { request: Request }): Promise<Response> {
	const body = await objectBody(request);
	const project = projectOr4xx(body.path);
	const fingerprints = parseFingerprints(body.fingerprints);
	if (!fingerprints.length) error(400, 'fingerprints required');
	const accepted = await acceptHostKeys(project.remote, fingerprints).catch((e: Error) => error(502, e.message));
	if (!accepted) error(409, "the host's keys no longer match the ones you checked: check again");
	return json({ hostKey: 'trusted' });
}
