import { json, error } from '@sveltejs/kit';
import fs from 'node:fs';
import type { RequestHandler } from './$types';
import { isAgentKind, type SessionIssue, type SessionKind, type IssueSourceType } from '$lib/types';
import { listSessions, createSession } from '$lib/server/sessions';
import { createWorktree, isGitRepo } from '$lib/server/git';
import { agentSend } from '$lib/server/agents/dispatch';
import { listProjects, updateProject } from '$lib/server/store';
import { expandTilde } from '$lib/server/fsutil';

const KINDS: SessionKind[] = ['claude', 'pi', 'codex', 'shell'];
const ISSUE_SOURCES: IssueSourceType[] = ['github', 'linear', 'clickup'];

type WorktreeReq = { branch?: string; newBranch?: boolean; base?: string };
type Worktree = { repo: string; branch: string; createdBranch: boolean };

// Substitute [title]/[branch-name]/[base-branch]/[cwd]/[issue_id]/[issue_url] in
// a first prompt. [branch] is kept as a back-compat alias for [branch-name].
function resolvePrompt(
	template: string,
	title: string,
	wt: WorktreeReq | undefined,
	cwd: string,
	issue: SessionIssue | undefined
): string {
	const { branch = '', base = '' } = wt ?? {};
	const { id = '', url = '' } = issue ?? {};
	return template
		.replaceAll('[title]', title)
		.replaceAll('[branch-name]', branch)
		.replaceAll('[base-branch]', base)
		.replaceAll('[branch]', branch)
		.replaceAll('[cwd]', cwd)
		.replaceAll('[issue_id]', id)
		.replaceAll('[issue_url]', url)
		.trim();
}

const asStr = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

// Only http(s) — the url is rendered as a clickable header link, so reject
// javascript:/data: and other schemes even though the body is auth-gated.
function safeHttpUrl(url: unknown): string {
	if (typeof url !== 'string') return '';
	try {
		return /^https?:$/.test(new URL(url).protocol) ? url : '';
	} catch {
		return '';
	}
}

// Issue metadata the picker attaches; stored on the session for the header link.
function parseIssue(raw: unknown): SessionIssue | undefined {
	const o = (raw ?? {}) as Record<string, unknown>;
	const source = o.source as IssueSourceType;
	const id = asStr(o.id);
	if (!id || !ISSUE_SOURCES.includes(source)) return undefined;
	return { source, id, url: safeHttpUrl(o.url) };
}

function resolveCwd(raw: unknown): string {
	const cwd = expandTilde(String(raw ?? ''));
	if (!cwd || !fs.existsSync(cwd)) error(400, 'cwd does not exist');
	return cwd;
}

// Remember the chosen base branch on the project so the next session defaults to it.
function rememberBase(repo: string, newBranch: boolean, base: string | undefined): void {
	if (!newBranch) return;
	if (listProjects().some((p) => p.path === repo)) updateProject(repo, { lastBase: base });
}

// Create the isolated worktree the session will run in.
async function makeWorktree(
	cwd: string,
	wt: WorktreeReq
): Promise<{ cwd: string; worktree: Worktree }> {
	if (!(await isGitRepo(cwd))) error(400, 'worktree requested but cwd is not a git repo');
	const repo = cwd;
	const base = wt.base || undefined;
	const dir = await createWorktree(repo, wt.branch!, { newBranch: wt.newBranch, base });
	rememberBase(repo, !!wt.newBranch, base);
	return { cwd: dir, worktree: { repo, branch: wt.branch!, createdBranch: !!wt.newBranch } };
}

// Resolve the effective cwd + worktree for the request (no-op when no branch given).
async function resolveWorktree(
	cwd: string,
	body: { worktree?: WorktreeReq }
): Promise<{ cwd: string; worktree?: Worktree; wt?: WorktreeReq; branch: string }> {
	const wt = body.worktree?.branch ? body.worktree : undefined;
	if (!wt) return { cwd, branch: '' };
	const made = await makeWorktree(cwd, wt);
	return { cwd: made.cwd, worktree: made.worktree, wt, branch: wt.branch! };
}

// Kick off the agent's first turn if a non-empty prompt was supplied.
function maybeDispatch(
	session: Awaited<ReturnType<typeof createSession>>,
	kind: SessionKind,
	prompt: unknown,
	wt: WorktreeReq | undefined,
	cwd: string,
	issue: SessionIssue | undefined
): void {
	if (!isAgentKind(kind)) return;
	if (typeof prompt !== 'string' || !prompt.trim()) return;
	agentSend(session, resolvePrompt(prompt, session.title, wt, cwd, issue));
}

export const GET: RequestHandler = async () => {
	return json(await listSessions());
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { kind, title, model, provider, permissionMode, command, prompt } = body;
	if (!KINDS.includes(kind)) error(400, 'invalid kind');

	const { cwd, worktree, wt, branch } = await resolveWorktree(resolveCwd(body.cwd), body);
	const issue = parseIssue(body.issue);

	const session = await createSession({
		kind,
		title: title || branch,
		cwd,
		model,
		provider,
		permissionMode,
		command,
		worktree,
		issue
	});

	maybeDispatch(session, kind, prompt, wt, cwd, issue);
	return json(session, { status: 201 });
};
