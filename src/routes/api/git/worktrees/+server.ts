import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listWorktrees, isGitRepo } from '$lib/server/git';
import { expandTilde } from '$lib/server/fsutil';

export const GET: RequestHandler = async ({ url }) => {
	const repo = url.searchParams.get('repo');
	if (!repo) error(400, 'repo required');
	const dir = expandTilde(repo);
	if (!(await isGitRepo(dir))) return json([]);
	return json(await listWorktrees(dir));
};
