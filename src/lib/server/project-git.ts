import { error, json } from '@sveltejs/kit';
import { isGitRepo, listBranches, listWorktrees, type Repo } from './git';
import { connectionFor, remoteProject, remoteRepo as repoOnHost } from './remote';
import { expandTilde } from './fsutil';
import { isWithinProjects } from './confine';

// The branch and worktree lists for a project's repo, each shared verbatim by
// a browser route under /api/git and its agent API twin under /api/agent/git.

// Resolve the `repo` query param to a git directory confined to the registered
// project set. Returns null when the target is out of bounds or not a repo, so
// the caller answers with an empty list rather than running git against an
// arbitrary path on the host.
async function resolveRepoParam(repo: string | null): Promise<Repo | null> {
	if (!repo) error(400, 'repo required');
	const dir = expandTilde(repo);
	if (!isWithinProjects(dir)) return null;
	const target = remoteRepo(dir) ?? dir;
	if (!(await isGitRepo(target))) return null;
	return target;
}

// A remote project's branches live in its checkout on the host (issue #410).
function remoteRepo(dir: string): Repo | null {
	const project = remoteProject(dir);
	if (!project) return null;
	try {
		return repoOnHost(connectionFor(project.path, project.remote), project.remote.path);
	} catch {
		return null;
	}
}

export async function branchesRoute({ url }: { url: URL }): Promise<Response> {
	const dir = await resolveRepoParam(url.searchParams.get('repo'));
	return json(dir ? await listBranches(dir) : []);
}

export async function worktreesRoute({ url }: { url: URL }): Promise<Response> {
	const dir = await resolveRepoParam(url.searchParams.get('repo'));
	return json(dir ? await listWorktrees(dir) : []);
}
