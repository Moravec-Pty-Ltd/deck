import { error, json } from '@sveltejs/kit';
import { isGitRepo, listBranches, listWorktrees } from './git';
import { expandTilde } from './fsutil';
import { isWithinProjects } from './confine';

// The branch and worktree lists for a project's repo, each shared verbatim by
// a browser route under /api/git and its agent API twin under /api/agent/git.

// Resolve the `repo` query param to a git directory confined to the registered
// project set. Returns null when the target is out of bounds or not a repo, so
// the caller answers with an empty list rather than running git against an
// arbitrary path on the host.
async function resolveRepoParam(repo: string | null): Promise<string | null> {
	if (!repo) error(400, 'repo required');
	const dir = expandTilde(repo);
	if (!isWithinProjects(dir)) return null;
	if (!(await isGitRepo(dir))) return null;
	return dir;
}

export async function branchesRoute({ url }: { url: URL }): Promise<Response> {
	const dir = await resolveRepoParam(url.searchParams.get('repo'));
	return json(dir ? await listBranches(dir) : []);
}

export async function worktreesRoute({ url }: { url: URL }): Promise<Response> {
	const dir = await resolveRepoParam(url.searchParams.get('repo'));
	return json(dir ? await listWorktrees(dir) : []);
}
