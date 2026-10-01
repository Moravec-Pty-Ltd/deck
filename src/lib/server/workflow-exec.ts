// The outside-world reads a workflow run's gates need (issue #233): a snapshot
// of the working tree, the verify command, and the gh queries. Every one runs
// inside a registered project or its worktrees (confine.ts); a run whose cwd
// has left that set gets an error, not a command.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { confineRelative, resolveWithinProjects } from './confine';
import { isFlagSafe } from './agents/args';
import { detectVerifyCommand, deltaRanges, type PrReviewView } from './workflow-core';
import type { WorkflowRun } from '$lib/workflows';

const exec = promisify(execFile);
const GH_TIMEOUT_MS = 30_000;
const VERIFY_TIMEOUT_MS = 20 * 60_000;
const OUTPUT_TAIL = 4000;

function confined(cwd: string): string {
	const real = resolveWithinProjects(cwd);
	if (real === null) throw new Error(`run directory is outside the registered projects: ${cwd}`);
	return real;
}

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
	const { stdout } = await exec('git', ['-C', confined(cwd), ...args], { env, maxBuffer: 16 * 1024 * 1024 });
	return stdout.trim();
}

// The whole working tree (staged, unstaged, and untracked, minus ignored files)
// as a git tree id, written through a throwaway index so the real one is never
// touched. Two snapshots diff to exactly what changed between them, whoever
// made the change, which is how a review round sees hand edits.
export async function snapshotTree(cwd: string): Promise<string> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-run-index-'));
	const env = { ...process.env, GIT_INDEX_FILE: path.join(dir, 'index') };
	try {
		await git(cwd, ['read-tree', 'HEAD'], env);
		await git(cwd, ['add', '-A'], env);
		return await git(cwd, ['write-tree'], env);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// The ranges that changed between two snapshots.
export async function deltaBetween(cwd: string, from: string, to: string): Promise<string[]> {
	return deltaRanges(await git(cwd, ['diff', '-U0', from, to]));
}

// The worktree root a directory sits in, so one run per worktree holds for runs
// started from different subdirectories of it.
export async function toplevel(cwd: string): Promise<string> {
	return git(cwd, ['rev-parse', '--show-toplevel']);
}

export async function currentBranch(cwd: string): Promise<string> {
	return git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

// Move an existing pr/<n> checkout to the PR's current head. fetchPullRef
// reuses the ref once it exists (plain review sessions rely on that), so a
// push since the ref was fetched would otherwise be reviewed from the old
// commit. A fetch can't update a checked-out branch, but a hard reset inside
// its worktree can; the clean drops anything a previous round left behind.
export async function syncPullWorktree(cwd: string, prNumber: number): Promise<void> {
	if (!Number.isSafeInteger(prNumber) || prNumber <= 0) throw new Error(`invalid PR number: ${prNumber}`);
	await git(cwd, ['fetch', 'origin', `pull/${prNumber}/head`]);
	await git(cwd, ['reset', '--hard', 'FETCH_HEAD']);
	await git(cwd, ['clean', '-fd']);
}

function readScripts(root: string): Record<string, string> | undefined {
	const file = confineRelative(root, 'package.json');
	try {
		return file ? JSON.parse(fs.readFileSync(file, 'utf8')).scripts : undefined;
	} catch {
		return undefined;
	}
}

function lockfiles(root: string): string[] {
	return ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb'].filter((f) => fs.existsSync(path.join(root, f)));
}

export function verifyCommand(cwd: string, override?: string): string | null {
	if (override) return override;
	const root = confined(cwd);
	return detectVerifyCommand(readScripts(root), lockfiles(root));
}

// Kill the command's whole process group: `pnpm run check && pnpm test` runs
// its tools as grandchildren, which a signal to `sh` alone would orphan.
function killGroup(pid: number | undefined): void {
	if (!pid) return;
	try {
		process.kill(-pid, 'SIGTERM');
	} catch {
		// already gone
	}
}

// Run the verify command; the gate is its exit code. CI=1 keeps test runners out
// of watch mode. An abort or the timeout stops every process it started.
export function runVerify(cwd: string, command: string, signal?: AbortSignal): Promise<{ code: number; output: string }> {
	const child = spawn('sh', ['-c', command], { cwd: confined(cwd), env: { ...process.env, CI: '1' }, detached: true });
	let output = '';
	const collect = (chunk: Buffer) => (output = (output + chunk.toString()).slice(-OUTPUT_TAIL));
	child.stdout.on('data', collect);
	child.stderr.on('data', collect);
	const stop = () => killGroup(child.pid);
	const timer = setTimeout(stop, VERIFY_TIMEOUT_MS);
	signal?.addEventListener('abort', stop, { once: true });
	return new Promise((resolve) => {
		child.on('error', (e) => collect(Buffer.from(e.message)));
		child.on('close', (code) => {
			clearTimeout(timer);
			signal?.removeEventListener('abort', stop);
			resolve({ code: code ?? 1, output: output || 'command failed' });
		});
	});
}

async function gh(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await exec('gh', args, { cwd: confined(cwd), timeout: GH_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
	return stdout;
}

interface PrLinkView {
	state: string;
	number: number;
	url: string;
	title: string;
	baseRefName: string;
	closingIssuesReferences: { number: number }[];
}

// The PR open for the run's branch, if any. A merged or closed PR from an
// earlier run of the same branch doesn't count.
export async function prForBranch(run: WorkflowRun): Promise<PrLinkView | null> {
	if (!isFlagSafe(run.branch)) return null;
	try {
		const out = await gh(run.cwd, ['pr', 'view', run.branch, '--json', 'state,number,url,title,baseRefName,closingIssuesReferences']);
		const pr = JSON.parse(out) as PrLinkView;
		return pr.state === 'OPEN' ? pr : null;
	} catch {
		return null;
	}
}

const THREADS_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      reviewThreads(first:100){ nodes{ isResolved } }
    }
  }
}`;

async function unresolvedThreads(cwd: string, repo: string, number: number): Promise<number> {
	const [owner, name] = repo.split('/');
	const out = await gh(cwd, ['api', 'graphql', '-f', `owner=${owner}`, '-f', `repo=${name}`, '-F', `number=${number}`, '-f', `query=${THREADS_QUERY}`]);
	const nodes = JSON.parse(out)?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
	return nodes.filter((n: { isResolved: boolean }) => !n.isResolved).length;
}

interface RawReview {
	author?: { login?: string };
	state: string;
	commit?: { oid?: string };
}

// The review state the feedback and pr-review gates read.
export async function prReviewView(cwd: string, repo: string, number: number): Promise<PrReviewView> {
	const out = await gh(cwd, ['pr', 'view', String(number), '-R', repo, '--json', 'state,reviewDecision,reviews,headRefOid']);
	const raw = JSON.parse(out) as { state: string; reviewDecision: string | null; reviews: RawReview[]; headRefOid: string };
	return {
		state: raw.state,
		reviewDecision: raw.reviewDecision || null,
		headRefOid: raw.headRefOid,
		reviews: raw.reviews.map((r) => ({ author: r.author?.login ?? '', state: r.state, commit: r.commit?.oid })),
		unresolvedThreads: await unresolvedThreads(cwd, repo, number)
	};
}

let login: string | null = null;

export async function ghLogin(cwd: string): Promise<string> {
	login ??= (await gh(cwd, ['api', 'user', '-q', '.login'])).trim();
	return login;
}
