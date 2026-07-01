import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isFlagSafe } from './agents/args';

const exec = promisify(execFile);

async function git(repo: string, ...args: string[]): Promise<string> {
	const { stdout } = await exec('git', ['-C', repo, ...args]);
	return stdout;
}

// A diff can run to several MB before the size cap trims it, well past
// execFile's 1 MB default; raise the buffer so the patch isn't cut mid-stream.
const DIFF_MAX_BUFFER = 64 * 1024 * 1024;

async function gitBig(repo: string, env: NodeJS.ProcessEnv, ...args: string[]): Promise<string> {
	const { stdout } = await exec('git', ['-C', repo, ...args], { env, maxBuffer: DIFF_MAX_BUFFER });
	return stdout;
}

export async function isGitRepo(dir: string): Promise<boolean> {
	try {
		await git(dir, 'rev-parse', '--git-dir');
		return true;
	} catch {
		return false;
	}
}

export async function listBranches(repo: string): Promise<string[]> {
	const out = await git(repo, 'branch', '-a', '--format', '%(refname:short)');
	const branches = out
		.trim()
		.split('\n')
		.filter(Boolean)
		.map((b) => b.replace(/^origin\//, ''))
		.filter((b) => b !== 'HEAD' && !b.includes(' '));
	return [...new Set(branches)];
}

export interface WorktreeEntry {
	path: string;
	branch: string;
	isMain: boolean;
}

// Existing worktrees for a repo, parsed from `git worktree list --porcelain`.
// The first entry git reports is the main working tree (the repo itself).
export async function listWorktrees(repo: string): Promise<WorktreeEntry[]> {
	let out: string;
	try {
		out = await git(repo, 'worktree', 'list', '--porcelain');
	} catch {
		return [];
	}
	const entries: WorktreeEntry[] = [];
	let current: { path?: string; branch?: string } = {};
	const flush = () => {
		if (current.path) {
			entries.push({
				path: current.path,
				branch: current.branch ?? '(detached)',
				isMain: entries.length === 0
			});
		}
		current = {};
	};
	for (const line of out.split('\n')) {
		if (line.startsWith('worktree ')) {
			flush();
			current.path = line.slice('worktree '.length).trim();
		} else if (line.startsWith('branch ')) {
			current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
		}
	}
	flush();
	return entries;
}

// Build the `git worktree add` argv. Positional args (the worktree dir and the
// branch/base ref) go after `--` so none can be read as an option even if an
// upstream guard is missed.
export function worktreeAddArgs(
	dir: string,
	branch: string,
	opts: { newBranch?: boolean; base?: string }
): string[] {
	if (!opts.newBranch) return ['worktree', 'add', '--', dir, branch];
	const args = ['worktree', 'add', '-b', branch, '--', dir];
	if (opts.base) args.push(opts.base);
	return args;
}

// Worktrees land next to the repo: <repo>-worktrees/<branch>
export async function createWorktree(
	repo: string,
	branch: string,
	opts: { newBranch?: boolean; base?: string } = {}
): Promise<string> {
	// branch/base reach git as ref arguments; a value starting with `-` would be
	// parsed as a flag (the class isFlagSafe guards elsewhere), and `.`/`..`
	// survive the dir sanitiser as path segments. Reject crafted refs, keep the
	// worktree dir a direct child of the -worktrees root, and pass positionals
	// after `--` (see worktreeAddArgs).
	if (!isFlagSafe(branch)) throw new Error(`unsafe branch name: ${branch}`);
	if (opts.base !== undefined && !isFlagSafe(opts.base))
		throw new Error(`unsafe base branch: ${opts.base}`);
	const safe = branch.replace(/[^a-zA-Z0-9._/-]/g, '-').replace(/\//g, '-');
	const worktrees = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`);
	const dir = path.join(worktrees, safe);
	if (!dir.startsWith(worktrees + path.sep)) throw new Error(`unsafe branch name: ${branch}`);
	if (fs.existsSync(dir)) return dir;
	fs.mkdirSync(path.dirname(dir), { recursive: true });
	await git(repo, ...worktreeAddArgs(dir, branch, opts));
	return dir;
}

// Fetch a PR's head into a local branch `pr/<n>` so a worktree can be checked
// out on it. Works for same-repo and fork PRs alike, since GitHub exposes fork
// heads under the base repo's pull/* refs. Idempotent: if `pr/<n>` already exists
// (a re-open, or another worktree already holds it — git refuses to update a
// checked-out branch) the existing ref is reused. Assumes `origin` is the GitHub
// repo, which holds for registered projects; anything else fails with a clear
// error. Returns the local branch name.
export async function fetchPullRef(repo: string, prNumber: number): Promise<string> {
	// Safe integer only: rejects scientific-notation / oversized coercions so a
	// crafted number can't form a bogus pull/<n> ref (the route bounds it too).
	if (!Number.isSafeInteger(prNumber) || prNumber <= 0) throw new Error(`invalid PR number: ${prNumber}`);
	const branch = `pr/${prNumber}`;
	// branch reaches git as a ref arg; pr/<n> is isFlagSafe, but assert at the sink.
	if (!isFlagSafe(branch)) throw new Error(`unsafe branch name: ${branch}`);
	if (await refExists(repo, branch)) return branch;
	try {
		await git(repo, 'fetch', 'origin', `pull/${prNumber}/head:${branch}`);
	} catch (e) {
		throw new Error(
			`failed to fetch PR #${prNumber} from origin (is origin the GitHub repo?): ${e instanceof Error ? e.message : e}`
		);
	}
	return branch;
}

// owner/repo parsed from a GitHub remote URL, or null if it doesn't look like
// one. Handles https, scp-style ssh (git@host:owner/repo), ssh:// URLs, host
// aliases, and an optional .git suffix / trailing slash. Case is preserved;
// compare case-insensitively (GitHub owners/repos are case-insensitive).
export function parseOriginRepo(remoteUrl: string): string | null {
	const url = remoteUrl.trim();
	// Only real fetchable remotes resolve: a network `scheme://host/…` with a
	// non-empty host (http(s)/ssh/git only, so every `file://…` form is out), or
	// scp-style `host:owner/repo` where the colon is followed by the path (so not a
	// Windows drive `C:/…`). Bare/relative paths, file URLs, and drive paths are
	// local origins that can't serve pull/* refs, so return null and let
	// scopeToOrigin skip filtering rather than scope to a bogus owner/repo.
	const hasHostUrl = /^(?:https?|ssh|git):\/\/[^/]/i.test(url);
	const isScp = !url.includes('://') && /^[^/]*[^/:]:[^/]/.test(url);
	if (!hasHostUrl && !isScp) return null;
	const m = url
		.replace(/\/$/, '')
		.replace(/\.git$/i, '')
		.match(/[/:]([^/:]+)\/([^/:]+)$/);
	return m ? `${m[1]}/${m[2]}` : null;
}

// The owner/repo behind a repo's `origin` remote, or null when there's no origin
// or it isn't a recognisable GitHub remote. Review mode uses this to scope the PR
// picker to the repo it can actually check a PR out from.
export async function originRepo(repo: string): Promise<string | null> {
	try {
		return parseOriginRepo(await git(repo, 'remote', 'get-url', 'origin'));
	} catch {
		return null;
	}
}

// --- worktree diff (the Changes tab) -------------------------------------

const PATCH_CAP = 5 * 1024 * 1024; // ~5 MB of patch before we trim whole files
// Neutralise repo diff config that would confuse the patch parser (no external
// diff drivers, force a/ b/ prefixes regardless of diff.noprefix/mnemonicPrefix).
const DIFF_FLAGS = ['--no-ext-diff', '--default-prefix'];

export interface DiffStats {
	fileCount: number;
	additions: number;
	deletions: number;
}

// Public summary the diff endpoint returns alongside the patch.
export interface WorktreeDiffMeta extends DiffStats {
	baseRef: string;
	baseResolved: boolean;
	truncated: boolean;
}

export interface WorktreeDiff {
	patch: string;
	meta: WorktreeDiffMeta;
}

interface DiffBase {
	baseRef: string; // human label of the base used, or 'HEAD' on fallback
	mergeBase: string; // commit the diff is taken against
	baseResolved: boolean;
}

async function refExists(repo: string, ref: string): Promise<boolean> {
	try {
		await git(repo, 'rev-parse', '--verify', '--quiet', ref);
		return true;
	} catch {
		return false;
	}
}

// origin/HEAD resolved to the branch it points at (e.g. origin/main), or null.
async function originHeadRef(repo: string): Promise<string | null> {
	try {
		const ref = (await git(repo, 'rev-parse', '--abbrev-ref', 'origin/HEAD')).trim();
		return ref && ref !== 'origin/HEAD' ? ref : null;
	} catch {
		return null;
	}
}

// First of origin/HEAD -> main -> master that resolves, else null.
async function defaultBranchRef(repo: string): Promise<string | null> {
	const head = await originHeadRef(repo);
	if (head) return head;
	for (const ref of ['main', 'master']) {
		if (await refExists(repo, ref)) return ref;
	}
	return null;
}

async function mergeBaseOf(repo: string, ref: string): Promise<string | null> {
	try {
		return (await git(repo, 'merge-base', ref, 'HEAD')).trim() || null;
	} catch {
		return null;
	}
}

// The base ref to diff against and its merge-base with HEAD, or null if neither
// the requested base nor the default branch shares history with HEAD.
async function pickBase(repo: string, base: string | undefined): Promise<DiffBase | null> {
	const ref = base || (await defaultBranchRef(repo));
	if (!ref) return null;
	const mergeBase = await mergeBaseOf(repo, ref);
	return mergeBase ? { baseRef: ref, mergeBase, baseResolved: true } : null;
}

// Resolve the commit the diff is taken against: the merge-base of the
// persisted/default base and HEAD, falling back to HEAD (working-tree-only)
// when there's no usable base or no shared history.
async function resolveDiffBase(repo: string, base: string | undefined): Promise<DiffBase> {
	const picked = await pickBase(repo, base);
	if (picked) return picked;
	const head = (await git(repo, 'rev-parse', 'HEAD')).trim();
	return { baseRef: 'HEAD', mergeBase: head, baseResolved: false };
}

// Untracked, non-ignored files (paths relative to repo), NUL-split.
async function untrackedFiles(repo: string): Promise<string[]> {
	const out = await gitBig(repo, process.env, 'ls-files', '--others', '--exclude-standard', '-z');
	return out.split('\0').filter(Boolean);
}

async function realIndexPath(repo: string): Promise<string | null> {
	try {
		const p = (await git(repo, 'rev-parse', '--path-format=absolute', '--git-path', 'index')).trim();
		return p && fs.existsSync(p) ? p : null;
	} catch {
		return null;
	}
}

interface DiffEnv {
	env: NodeJS.ProcessEnv;
	cleanup: () => void;
}

// Batch the pathspecs so a worktree with thousands of untracked files (e.g. an
// un-ignored node_modules) can't blow past ARG_MAX and lose them all at once.
async function addIntentToAdd(repo: string, env: NodeJS.ProcessEnv, paths: string[]): Promise<void> {
	const BATCH = 500;
	for (let i = 0; i < paths.length; i += BATCH) {
		await gitBig(repo, env, 'add', '--intent-to-add', '--', ...paths.slice(i, i + BATCH));
	}
}

// A throwaway index seeded from the repo's real index, with the untracked files
// marked intent-to-add so `git diff` surfaces them as new-file additions. The
// real index is never touched; cleanup removes the temp copy.
async function untrackedIndexEnv(repo: string, untracked: string[]): Promise<DiffEnv> {
	const realIndex = await realIndexPath(repo);
	if (!realIndex) return { env: process.env, cleanup: () => {} };
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-diff-'));
	fs.copyFileSync(realIndex, path.join(dir, 'index'));
	const env = { ...process.env, GIT_INDEX_FILE: path.join(dir, 'index') };
	const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
	try {
		await addIntentToAdd(repo, env, untracked);
	} catch {
		// odd/unreadable untracked paths: fall back to a tracked-only diff
	}
	return { env, cleanup };
}

async function diffEnv(repo: string, untracked: string[]): Promise<DiffEnv> {
	if (untracked.length === 0) return { env: process.env, cleanup: () => {} };
	return untrackedIndexEnv(repo, untracked);
}

interface DiffContext extends DiffEnv {
	base: DiffBase;
}

async function diffContext(repo: string, base: string | undefined): Promise<DiffContext> {
	const resolved = await resolveDiffBase(repo, base);
	const untracked = await untrackedFiles(repo);
	const { env, cleanup } = await diffEnv(repo, untracked);
	return { base: resolved, env, cleanup };
}

// Sum additions/deletions from `git diff --numstat`. Binary rows report `-` and
// contribute 0; fileCount is the row count.
export function parseNumstat(out: string): DiffStats {
	const rows = out.split('\n').filter(Boolean);
	let additions = 0;
	let deletions = 0;
	for (const row of rows) {
		const [add, del] = row.split('\t');
		additions += Number(add) || 0;
		deletions += Number(del) || 0;
	}
	return { fileCount: rows.length, additions, deletions };
}

// Cap the patch at PATCH_CAP on whole-file boundaries so a giant diff can't
// freeze the renderer; truncated says whether any files were dropped.
export function capPatch(patch: string): { patch: string; truncated: boolean } {
	if (patch.length <= PATCH_CAP) return { patch, truncated: false };
	const files = patch.split(/(?=^diff --git )/m);
	const kept: string[] = [];
	let size = 0;
	for (const file of files) {
		if (size + file.length > PATCH_CAP) break;
		kept.push(file);
		size += file.length;
	}
	return { patch: kept.join(''), truncated: kept.length < files.length };
}

function buildMeta(base: DiffBase, stats: DiffStats, truncated: boolean): WorktreeDiffMeta {
	return { ...stats, baseRef: base.baseRef, baseResolved: base.baseResolved, truncated };
}

// All changes in `cwd` since its base branch as one unified patch: committed +
// staged + unstaged + untracked. `base` is the persisted worktree base; when
// absent or unusable it resolves to the default-branch merge-base, then to HEAD
// (working-tree-only) with baseResolved=false so the UI can explain the fallback.
export async function worktreeDiff(cwd: string, base?: string): Promise<WorktreeDiff> {
	const ctx = await diffContext(cwd, base);
	try {
		const mb = ctx.base.mergeBase;
		const numstat = await gitBig(cwd, ctx.env, 'diff', ...DIFF_FLAGS, '--numstat', mb, '--');
		const raw = await gitBig(cwd, ctx.env, 'diff', ...DIFF_FLAGS, mb, '--');
		const capped = capPatch(raw);
		return { patch: capped.patch, meta: buildMeta(ctx.base, parseNumstat(numstat), capped.truncated) };
	} finally {
		ctx.cleanup();
	}
}

// Just the summary (file count + base resolution) for the tab badge, skipping
// the patch build. Still resolves untracked so the count matches the full diff.
export async function worktreeDiffMeta(cwd: string, base?: string): Promise<WorktreeDiffMeta> {
	const ctx = await diffContext(cwd, base);
	try {
		const numstat = await gitBig(cwd, ctx.env, 'diff', ...DIFF_FLAGS, '--numstat', ctx.base.mergeBase, '--');
		return buildMeta(ctx.base, parseNumstat(numstat), false);
	} finally {
		ctx.cleanup();
	}
}

export async function removeWorktree(
	repo: string,
	worktreeDir: string,
	opts: { deleteBranch?: boolean; branch?: string } = {}
) {
	// --force: drop the worktree even with uncommitted changes (user opted in)
	await git(repo, 'worktree', 'remove', '--force', worktreeDir);
	if (opts.deleteBranch && opts.branch) {
		try {
			await git(repo, 'branch', '-D', opts.branch);
		} catch {
			// branch may be checked out elsewhere or already gone — non-fatal
		}
	}
}
