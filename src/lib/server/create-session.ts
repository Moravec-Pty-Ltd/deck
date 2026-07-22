import { error } from '@sveltejs/kit';
import fs from 'node:fs';
import { isAgentKind, type AgentKind, type DeckEffort, type SessionIssue, type SessionKind, type SessionPR, type IssueSourceType } from '$lib/types';
import { createSession } from './sessions';
import { createWorktree, fetchPullRef, isGitRepo } from './git';
import { isFlagSafe } from './agents/args';
import { agentSend } from './agents/dispatch';
import { appendEvent } from './claude';
import { listProjects, updateProject, rememberModel, rememberEffort, readSecret } from './store';
import { parseEffort } from './session-effort-core';
import { expandTilde } from './fsutil';
import { resolveWithinProjects, projectForPath } from './confine';
import { expandPlaceholders, contextFromSession } from '$lib/placeholders';
import { buildIssuePrompt, type IssueForFetch, type IssuePromptContext } from './issues/detail';

// The create-session request pipeline, extracted from the POST /api/sessions
// route so the agent API (POST /api/agent/sessions) can share it. Validation
// failures throw SvelteKit error()s, which both routes surface as-is.

const KINDS: SessionKind[] = ['claude', 'pi', 'codex', 'opencode', 'shell'];
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

// Cap on issues attached to one session — the picker is a shortlist, and this
// bounds the create-time detail fan-out.
const ISSUE_CAP = 10;

// One issue as the picker attaches it: the persisted `SessionIssue` plus the
// transient `sourceId`, kept only to look up the API key for the detail fetch.
interface PickedIssue {
	issue: SessionIssue;
	sourceId: string;
}

function parseIssue(raw: unknown): PickedIssue | undefined {
	const o = (raw ?? {}) as Record<string, unknown>;
	const source = o.source as IssueSourceType;
	const id = asStr(o.id);
	if (!id || !ISSUE_SOURCES.includes(source)) return undefined;
	return { issue: { source, id, url: safeHttpUrl(o.url) }, sourceId: asStr(o.sourceId) };
}

// Issue metadata the picker attaches; stored on the session for the header
// links. Accepts the multi-issue `issues` array, falling back to a legacy single
// `issue`, and caps the count.
function parseIssues(body: { issues?: unknown; issue?: unknown }): PickedIssue[] {
	const raw = Array.isArray(body.issues) ? body.issues : body.issue != null ? [body.issue] : [];
	return raw
		.map(parseIssue)
		.filter((x): x is PickedIssue => !!x)
		.slice(0, ISSUE_CAP);
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
// reach the gh PR sync/actions); url/title are best-effort. Exported so the
// agent API can 400 on an invalid pr up front (a silently dropped one would
// create a session whose review/merge endpoints can never work).
export function parsePr(raw: unknown): SessionPR | undefined {
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

// Persist the chosen model so the next new-session in this project defaults to
// it (and, as a fresh-project fallback, the last one used anywhere). `cwd` may
// be a worktree dir (existing-worktree mode), so map it back to its project
// before keying the per-project write. pi carries a separate provider; the
// other kinds put the whole id in `model`. rememberModel no-ops on a blank
// model, so no guard is needed here.
function rememberPickedModel(cwd: string, kind: AgentKind, model: unknown, provider: unknown): void {
	const provider_ = kind === 'pi' ? asStr(provider) || undefined : undefined;
	rememberModel(projectForPath(cwd) ?? cwd, kind, { model: asStr(model), provider: provider_ });
}

// Persist the chosen effort so the next claude session in this project defaults to
// it (issue #178), the same per-project + global scoping as rememberPickedModel.
// claude-only (effort has no meaning for the other kinds); a no-op elsewhere so
// the caller stays branch-free.
function rememberPickedEffort(cwd: string, kind: SessionKind, effort: DeckEffort | undefined): void {
	if (kind !== 'claude') return;
	rememberEffort(projectForPath(cwd) ?? cwd, effort);
}

// Validate the create body's `effort`, returning the normalised level or a clean
// 400 (issue #178). Absent/blank is the CLI default; an unknown value is rejected;
// and effort is claude-only, so a level supplied for another kind 400s rather than
// being silently ignored (the same claude-only contract the /effort route enforces).
function safeEffort(raw: unknown, kind: SessionKind): DeckEffort | undefined {
	const parsed = parseEffort(raw);
	if (!parsed.ok) error(400, 'invalid effort');
	if (parsed.effort && kind !== 'claude') error(400, 'effort is only valid for claude sessions');
	return parsed.effort;
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
// unaffected: they reach no git sink). Returns the canonical (symlink-free) path,
// which the git/fs operations below must use so a symlink whose realpath is in
// bounds can't redirect the derived <repo>-worktrees dir out of bounds.
async function assertWorktreeCwd(cwd: string): Promise<string> {
	const repo = resolveWithinProjects(cwd);
	if (repo === null) error(403, 'worktree cwd must be within the registered project set');
	if (!(await isGitRepo(repo))) error(400, 'worktree requested but cwd is not a git repo');
	return repo;
}

// Create the isolated worktree the session will run in. A `fromPr` request forks
// off to the PR checkout; otherwise it's a normal branch/base worktree.
async function makeWorktree(
	cwd: string,
	wt: WorktreeReq
): Promise<{ cwd: string; worktree: Worktree }> {
	// `repo` (canonical) drives the git/fs work; `worktree.repo` keeps the original
	// cwd so downstream project matching (projectForSession compares p.path by
	// string, and project paths are stored un-canonicalized) still resolves.
	const repo = await assertWorktreeCwd(cwd);
	if (wt.fromPr !== undefined) return makePrWorktree(cwd, repo, wt);
	assertRefsSafe(wt);
	const base = wt.base || undefined;
	const dir = await createWorktree(repo, wt.branch!, { newBranch: wt.newBranch, base });
	rememberBase(cwd, !!wt.newBranch, base);
	return { cwd: dir, worktree: { repo: cwd, branch: wt.branch!, createdBranch: !!wt.newBranch, base } };
}

// Fetch the PR head into a local pr/<n> branch, surfacing a fetch failure as a
// 400. `created` reports whether deck fetched the ref (vs reused one another
// review session already holds), so ownership is recorded truthfully.
async function fetchPrBranch(cwd: string, number: number): Promise<{ branch: string; created: boolean }> {
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
	repo: string,
	wt: WorktreeReq
): Promise<{ cwd: string; worktree: Worktree }> {
	const number = toPrNumber(wt.fromPr);
	if (number === null) error(400, 'invalid PR number');
	const base = safeBase(wt);
	const { branch, created } = await fetchPrBranch(repo, number);
	const dir = await createWorktree(repo, branch, { newBranch: false });
	// `created` (not the worktree-add's newBranch) records ref ownership: deck
	// made the pr/<n> ref here, so branch cleanup on delete should drop it. A
	// pre-existing ref (another session already reviewing this PR) stays false.
	return { cwd: dir, worktree: { repo: cwd, branch, createdBranch: created, base } };
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

// Which API key (if any) the detail fetch needs: GitHub rides on `gh`; Linear /
// ClickUp read the source's stored key. Trusted single-user endpoint, so a key
// that isn't found just yields a best-effort empty detail.
function issuesForFetch(picked: PickedIssue[]): IssueForFetch[] {
	return picked.map((p) => ({
		issue: p.issue,
		apiKey: p.issue.source === 'github' ? undefined : readSecret(p.sourceId)
	}));
}

// The fetched [issue_title]/[issue_body]/[issue_comments] block for the first
// prompt, or empty when no issues are attached / the fetch fails (best-effort;
// the guard is belt-and-braces since buildIssuePrompt already swallows).
async function issueContext(cwd: string, picked: PickedIssue[]): Promise<Partial<IssuePromptContext>> {
	if (!picked.length) return {};
	// buildIssuePrompt writes assets + touches git under the cwd; confine that sink
	// to the registered project set (worktree or project), never an arbitrary
	// custom cwd, and write to the canonical (symlink-free) path it returns.
	const root = resolveWithinProjects(cwd);
	if (!root) return {};
	try {
		return await buildIssuePrompt(root, issuesForFetch(picked));
	} catch {
		return {};
	}
}

// Kick off the agent's first turn if a non-empty prompt was supplied, expanding
// its [tokens] against the freshly-created session. When issues are attached,
// their body/title/images are fetched server-side first (best-effort) so the
// prompt starts grounded. Fire-and-forget: the fetch must not delay the 201.
async function maybeDispatch(
	session: Awaited<ReturnType<typeof createSession>>,
	kind: SessionKind,
	promptText: string,
	picked: PickedIssue[]
): Promise<void> {
	if (!isAgentKind(kind)) return;
	if (!promptText) return;
	const ctx = { ...contextFromSession(session), ...(await issueContext(session.cwd, picked)) };
	await agentSend(session, expandPlaceholders(promptText, ctx));
}

// The whole POST /api/sessions pipeline for one untyped JSON body: validate,
// resolve the worktree, create the session, and fire the first turn.
export async function createSessionFromRequest(
	body: Record<string, unknown>
): Promise<Awaited<ReturnType<typeof createSession>>> {
	const { kind, title, model, provider, effort, permissionMode, command, prompt } = body as {
		kind: SessionKind;
		title?: string;
		model?: string;
		provider?: string;
		effort?: unknown;
		permissionMode?: Parameters<typeof createSession>[0]['permissionMode'];
		command?: string;
		prompt?: unknown;
	};
	if (!KINDS.includes(kind)) error(400, 'invalid kind');
	const effortLevel = safeEffort(effort, kind);

	const startCwd = resolveCwd(body.cwd);
	const { cwd, worktree, branch } = await resolveWorktree(startCwd, body as { worktree?: WorktreeReq });
	const picked = parseIssues(body);
	const pr = parsePr(body.pr);

	const session = await createSession({
		kind,
		title: title || branch,
		cwd,
		model,
		provider,
		effort: effortLevel,
		permissionMode,
		command,
		worktree,
		issues: picked.map((p) => p.issue),
		pr
	});

	if (isAgentKind(kind)) rememberPickedModel(startCwd, kind, model, provider);
	rememberPickedEffort(startCwd, kind, effortLevel);

	// Fire-and-forget, but not silent: a failed dispatch lands on the transcript
	// so the fresh session says why nothing is happening.
	void maybeDispatch(session, kind, asStr(prompt), picked).catch((e) => {
		console.error(`[deck] first-turn dispatch failed for ${session.id}:`, e);
		appendEvent(session.id, {
			type: 'deck.error',
			text: e instanceof Error ? e.message : 'failed to start the first turn',
			ts: Date.now()
		});
	});
	return session;
}
