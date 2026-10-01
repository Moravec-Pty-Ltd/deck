// The agent API's view of workflow runs (issue #233): request parsing and the
// digests the run routes serve. Shared by the web UI, which calls the same
// endpoints, so there is one surface for people, the overseer, and any outside
// orchestrator.
import { error } from '@sveltejs/kit';
import { parseIssue, parsePr } from './create-session';
import { isFlagSafe } from './agents/args';
import { expandTilde } from './fsutil';
import { baseUrl } from './config';
import { lastVisit, runDigest } from './workflow-core';
import { listRuns } from './workflow-store';
import { snapshotTree } from './workflow-exec';
import { WORKFLOW_CATEGORIES, type RunDigest, type RunPr, type WorkflowCategory, type WorkflowRun } from '$lib/workflows';
import type { StartRunRequest } from './workflow-runner';

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

function category(v: unknown): WorkflowCategory | undefined {
	const c = str(v);
	if (!c) return undefined;
	if (!(WORKFLOW_CATEGORIES as readonly string[]).includes(c)) error(400, 'category must be dev or review');
	return c as WorkflowCategory;
}

function safeRef(v: unknown, what: string): string | undefined {
	const ref = str(v);
	if (ref && !isFlagSafe(ref)) error(400, `invalid ${what}`);
	return ref || undefined;
}

function pr(v: unknown): RunPr | undefined {
	if (v == null) return undefined;
	const parsed = parsePr(v);
	if (!parsed) error(400, 'pr must be { repo: "owner/repo", number }');
	const { repo, number, url, title } = parsed;
	return { repo, number, url, title, baseRefName: safeRef((v as Record<string, unknown>).baseRefName, 'pr base') };
}

function issue(v: unknown): StartRunRequest['issue'] {
	if (v == null) return undefined;
	const picked = parseIssue(v);
	if (!picked) error(400, 'issue must be { source, id }');
	return { ...picked.issue, ...(picked.sourceId ? { sourceId: picked.sourceId } : {}) };
}

export function parseStartRequest(body: Record<string, unknown>): StartRunRequest {
	const cwd = expandTilde(str(body.cwd));
	if (!cwd) error(400, 'cwd is required');
	return {
		cwd,
		workflow: str(body.workflow) || undefined,
		category: category(body.category),
		issue: issue(body.issue),
		pr: pr(body.pr),
		base: safeRef(body.base, 'base branch'),
		title: str(body.title) || undefined
	};
}

export function digest(run: WorkflowRun): RunDigest {
	return runDigest(run, baseUrl);
}

// A run's tree snapshot, reused for a few seconds: the run page polls every 3s
// and a snapshot hashes the whole worktree.
const TREE_TTL_MS = 10_000;
// Keyed by run, remembering which handoff it was taken for, so a note saved
// within the TTL never reads as stale against an older snapshot.
const trees = new Map<string, { at: number; handoff: number; tree: Promise<string | null> }>();

function recentTree(run: WorkflowRun, handoff: number): Promise<string | null> {
	const hit = trees.get(run.id);
	if (hit && hit.handoff === handoff && Date.now() - hit.at < TREE_TTL_MS) return hit.tree;
	const tree = snapshotTree(run.cwd).catch(() => null);
	trees.set(run.id, { at: Date.now(), handoff, tree });
	return tree;
}

// The single-run digest, plus whether the handoff note still matches the tree.
export async function fullDigest(run: WorkflowRun): Promise<RunDigest & { handoffStale?: boolean }> {
	const d = digest(run);
	if (!run.handoff) return d;
	const tree = await recentTree(run, run.handoff.at);
	return { ...d, handoffStale: tree !== null && tree !== run.handoff.tree };
}

// A blocked run as GET /api/agent/asks lists it, next to the MCP asks, so a
// client that answers asks answers runs the same way. `sessionId` is the
// run's latest phase session when it has one: answering through that
// session's answer route unblocks the run.
export interface RunAsk {
	source: 'run';
	runId: string;
	sessionId?: string;
	questions: { question: string; header: string; options: [] }[];
	askedAt: number;
}

export function runAsks(): RunAsk[] {
	return listRuns()
		.filter((r) => r.status === 'blocked' && r.block)
		.map((r) => ({
			source: 'run',
			runId: r.id,
			sessionId: lastVisit(r)?.sessionId,
			questions: [{ question: r.block!.question, header: r.title, options: [] }],
			askedAt: r.block!.at
		}));
}
