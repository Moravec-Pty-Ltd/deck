import { json, error } from '@sveltejs/kit';
import fs from 'node:fs';
import type { RequestHandler } from './$types';
import { isAgentKind, type SessionIssue, type SessionKind, type SessionPR, type IssueSourceType } from '$lib/types';
import { listSessions, createSession } from '$lib/server/sessions';
import { createWorktree, fetchPullRef, isGitRepo } from '$lib/server/git';
import { isFlagSafe } from '$lib/server/agents/args';
import { agentSend } from '$lib/server/agents/dispatch';
import { listProjects, updateProject } from '$lib/server/store';
import { expandTilde } from '$lib/server/fsutil';
import { resolveWithinProjects } from '$lib/server/confine';
import { expandPlaceholders, contextFromSession } from '$lib/placeholders';

const KINDS: SessionKind[] = ['claude', 'pi', 'codex', 'shell'];
const ISSUE_SOURCES: IssueSourceType[] = ['github', 'linear', 'clickup'];

type WorktreeReq = { branch?: string; newBranch?: boolean; base?: string; fromPr?: unknown };
type Worktree = { repo: string; branch: string; createdBranch: boolean; base?: string };

// owner/repo, the only shape the PR sync/actions pass to `gh -R`; validated here
// so a crafted body can't reach that sink. Neither part may start with `-`, so
// the value can't be read as a flag.
const REPO_RE = /^[\w.][\w.-]*\/[\w.][\w.-]*$/;

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

// A PR number coerced from untyped JSON: a safe positive integer, so
// scientific-notation and oversized coercions can't reach the git fetch ref.
// null otherwise.
function toPrNumber(v: unknown): number | null {
	const n = typeof v === 'number' ? v : Number(v);
	return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// PR metadata the Review-mode picker attaches; stored on the session to seed the
// header PR chip and the [pr_*] placeholders. repo/number are validated (they
// reach the gh PR sync/actions); url/title are best-effort.
function parsePr(raw: unknown): SessionPR | undefined {
	const o = (raw ?? {}) as Record<string, unknown>;
	const repo = asStr(o.repo);
	const number = toPrNumber(o.number);
	if (!REPO_RE.test(repo) || number === null) return undefined;
	// title mirrors url: '' when absent (the picker always sends a real one).
	return { repo, number, url: safeHttpUrl(o.url), title: asStr(o.title), seenAt: Date.now() };
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

// A worktree ref is safe only if it is a string git won't read as a flag. The
// request body is untyped JSON, so a non-string truthy value must 400, not throw
// a 500 inside isFlagSafe's .startsWith.
function isSafeRef(v: unknown): boolean {
	return typeof v === 'string' && isFlagSafe(v);
}

// branch/base become git ref args; a leading dash is flag injection. createWorktree
// guards the sink too; this is the boundary check that returns a clean 400.
function assertRefsSafe(wt: WorktreeReq): void {
	if (!isSafeRef(wt.branch)) error(400, 'invalid branch name');
	if (wt.base && !isSafeRef(wt.base)) error(400, 'invalid base branch');
}

// Validate + normalise the PR base ref (the PR path skips assertRefsSafe, which
// also expects a branch). Returns undefined when no base was given.
function safeBase(wt: WorktreeReq): string | undefined {
	const base = wt.base || undefined;
	if (base && !isSafeRef(base)) error(400, 'invalid base branch');
	return base;
}

// Whether the request asked for a worktree at all: an existing/new branch, or a PR.
function worktreeRequested(wt?: WorktreeReq): boolean {
	return !!wt && (wt.fromPr !== undefined || !!wt.branch);
}

// Both worktree paths run `git -C <repo>` and write to <repo>-worktrees, the same
// git sink the /api/git/* endpoints confine. The picker feeding cwd is confined
// to $HOME + projects, but a direct POST is not, so gate the worktree cwd to the
// registered project set here too (custom-cwd sessions without a worktree are
// unaffected: they reach no git sink). Returns the canonical repo path, which the
// git/fs operations below must use so a symlink whose realpath is in bounds can't
// redirect the derived <repo>-worktrees dir out of bounds.
async function assertWorktreeCwd(cwd: string): Promise<string> {
	const repo = resolveWithinProjects(cwd);
	if (repo === null) error(403, 'worktree cwd must be a registered project');
	if (!(await isGitRepo(repo))) error(400, 'worktree requested but cwd is not a git repo');
	return repo;
}

// Create the isolated worktree the session will run in. A `fromPr` request forks
// off to the PR checkout; otherwise it's a normal branch/base worktree.
async function makeWorktree(
	cwd: string,
	wt: WorktreeReq
): Promise<{ cwd: string; worktree: Worktree }> {
	const repo = await assertWorktreeCwd(cwd);
	if (wt.fromPr !== undefined) return makePrWorktree(repo, wt);
	assertRefsSafe(wt);
	const base = wt.base || undefined;
	const dir = await createWorktree(repo, wt.branch!, { newBranch: wt.newBranch, base });
	rememberBase(cwd, !!wt.newBranch, base);
	return { cwd: dir, worktree: { repo, branch: wt.branch!, createdBranch: !!wt.newBranch, base } };
}

// Fetch the PR head into a local pr/<n> branch, surfacing a fetch failure as a 400.
async function fetchPrBranch(cwd: string, number: number): Promise<string> {
	try {
		return await fetchPullRef(cwd, number);
	} catch (e) {
		error(400, e instanceof Error ? e.message : 'failed to fetch PR branch');
	}
}

// Review mode: check out an existing-branch worktree on the fetched pr/<n> head.
// `base` (the PR's base ref) is persisted so the Changes tab renders the true PR
// diff (base...head) with no extra work.
async function makePrWorktree(
	cwd: string,
	wt: WorktreeReq
): Promise<{ cwd: string; worktree: Worktree }> {
	const number = toPrNumber(wt.fromPr);
	if (number === null) error(400, 'invalid PR number');
	const base = safeBase(wt);
	const branch = await fetchPrBranch(cwd, number);
	const dir = await createWorktree(cwd, branch, { newBranch: false });
	return { cwd: dir, worktree: { repo: cwd, branch, createdBranch: false, base } };
}

// Resolve the effective cwd + worktree for the request (no-op when neither a
// branch nor a PR is given). Both worktree paths return the effective branch via
// the built worktree, so the caller's title default works uniformly.
async function resolveWorktree(
	cwd: string,
	body: { worktree?: WorktreeReq }
): Promise<{ cwd: string; worktree?: Worktree; branch: string }> {
	const wt = body.worktree;
	if (!worktreeRequested(wt)) return { cwd, branch: '' };
	const made = await makeWorktree(cwd, wt!);
	return { cwd: made.cwd, worktree: made.worktree, branch: made.worktree.branch };
}

// Kick off the agent's first turn if a non-empty prompt was supplied, expanding
// its [tokens] against the freshly-created session.
function maybeDispatch(
	session: Awaited<ReturnType<typeof createSession>>,
	kind: SessionKind,
	prompt: unknown
): void {
	if (!isAgentKind(kind)) return;
	if (typeof prompt !== 'string' || !prompt.trim()) return;
	agentSend(session, expandPlaceholders(prompt, contextFromSession(session)));
}

export const GET: RequestHandler = async () => {
	return json(await listSessions());
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { kind, title, model, provider, permissionMode, command, prompt } = body;
	if (!KINDS.includes(kind)) error(400, 'invalid kind');

	const { cwd, worktree, branch } = await resolveWorktree(resolveCwd(body.cwd), body);
	const issue = parseIssue(body.issue);
	const pr = parsePr(body.pr);

	const session = await createSession({
		kind,
		title: title || branch,
		cwd,
		model,
		provider,
		permissionMode,
		command,
		worktree,
		issue,
		pr
	});

	maybeDispatch(session, kind, prompt);
	return json(session, { status: 201 });
};
