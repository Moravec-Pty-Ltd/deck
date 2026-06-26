// Background bulk status sync + review/merge actions for sessions' captured PRs,
// via the `gh` CLI (the same no-shell execFile pattern as server/issues/
// github.ts). The pure query-build / response-parse halves live in $lib/pr; this
// module runs the gh calls and writes the results back onto each session. Status
// sync is best-effort (any failure leaves the last-known state on the chip);
// actions surface gh's error to the caller.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildPrSyncQuery, parsePrSyncResponse, type PrRef, type PrSyncPatch } from '$lib/pr';
import type { SessionPR } from '$lib/types';
import { listStoredSessions, getStoredSession, updateSession } from './store';

const exec = promisify(execFile);

// Cap each gh call so a hung CLI (auth prompt, dead network) can't wedge a tick
// or an action, mirroring the issues helper.
const GH_TIMEOUT_MS = 15_000;

// GraphQL complexity ceiling: keep each aliased request to ~50 PRs, chunk beyond.
const SYNC_CHUNK = 50;

// gh review actions map to a single flag; exported so the route can guard the
// request with the same own-property pattern the server-action route uses.
export const REVIEW_FLAG = {
	approve: '--approve',
	'request-changes': '--request-changes',
	comment: '--comment'
} as const;
export const MERGE_FLAG = { squash: '--squash', merge: '--merge', rebase: '--rebase' } as const;

export type ReviewDecision = keyof typeof REVIEW_FLAG;
export type MergeMethod = keyof typeof MERGE_FLAG;

async function gh(args: string[]): Promise<string> {
	const { stdout } = await exec('gh', args, { maxBuffer: 16 * 1024 * 1024, timeout: GH_TIMEOUT_MS });
	return stdout;
}

// Run a gh action (review/merge) and surface gh's own stderr on failure so the
// route can return it inline (e.g. "Can not approve your own pull request").
async function ghAction(args: string[]): Promise<void> {
	try {
		await exec('gh', args, { maxBuffer: 16 * 1024 * 1024, timeout: GH_TIMEOUT_MS });
	} catch (e) {
		const err = e as { stderr?: string; message?: string };
		throw new Error((err.stderr || err.message || 'gh command failed').trim());
	}
}

interface SyncItem {
	id: string;
	pr: SessionPR;
}

// Re-read before persisting: a dismiss or a newer captured link may have landed
// during the gh call, so only write back if the stored PR is still the one we
// synced (matched by url).
function persistPatch(item: SyncItem, patch: PrSyncPatch) {
	const current = getStoredSession(item.id)?.pr;
	if (!current || current.url !== item.pr.url) return;
	updateSession(item.id, { pr: { ...current, ...patch, checkedAt: Date.now() } });
}

// Fetch one chunk's PR states in a single aliased GraphQL request and write each
// result back. A whole-chunk failure is swallowed (last-known state stays).
async function syncChunk(items: SyncItem[]): Promise<void> {
	const refs: PrRef[] = items.map((it) => ({ repo: it.pr.repo, number: it.pr.number }));
	const raw = await gh(['api', 'graphql', '-f', `query=${buildPrSyncQuery(refs)}`]).catch(() => null);
	if (raw === null) return;
	parsePrSyncResponse(raw, items.length).forEach((patch, i) => {
		if (patch) persistPatch(items[i], patch);
	});
}

async function syncItems(items: SyncItem[]): Promise<void> {
	for (let i = 0; i < items.length; i += SYNC_CHUNK) {
		await syncChunk(items.slice(i, i + SYNC_CHUNK));
	}
}

// Sessions whose captured PR is worth re-checking: not yet synced, or in a
// non-terminal state. `merged` is terminal (it never leaves merged) so it's
// skipped; open/draft/closed are re-checked (a closed PR can reopen).
function nonTerminalPrItems(): SyncItem[] {
	const items: SyncItem[] = [];
	for (const s of listStoredSessions()) {
		if (s.pr && s.pr.state !== 'merged') items.push({ id: s.id, pr: s.pr });
	}
	return items;
}

// Single-flight so a slow bulk fetch doesn't let the next tick start a second
// overlapping one. A single-PR refreshPr is deliberately not gated by this: an
// action must re-sync its PR right away, even mid-tick.
let syncing = false;

// The slow background tick: re-sync every non-terminal captured PR in one bulk
// request per chunk. Wired into the monitor (see monitor.ts).
export async function syncCapturedPrs(): Promise<void> {
	if (syncing) return;
	syncing = true;
	try {
		const items = nonTerminalPrItems();
		if (items.length) await syncItems(items);
	} finally {
		syncing = false;
	}
}

// Refresh a single session's PR immediately (after a review/merge, or the menu's
// Refresh) and return the updated PR so the caller can echo it back without
// waiting for the next tick.
export async function refreshPr(id: string): Promise<SessionPR | undefined> {
	const pr = getStoredSession(id)?.pr;
	if (pr) await syncChunk([{ id, pr }]);
	return getStoredSession(id)?.pr;
}

function requirePr(id: string): SessionPR {
	const pr = getStoredSession(id)?.pr;
	if (!pr) throw new Error('no PR captured for this session');
	return pr;
}

function reviewArgs(pr: SessionPR, decision: ReviewDecision, body: string): string[] {
	const args = ['pr', 'review', String(pr.number), '-R', pr.repo, REVIEW_FLAG[decision]];
	if (body.trim()) args.push('--body', body);
	return args;
}

// Submit a review (approve / request-changes / comment) on the session's own PR,
// then refresh so the chip colour + tally update at once. Inputs are validated at
// the route boundary; the repo/number come from the stored session, never the
// request.
export async function reviewPr(
	id: string,
	decision: ReviewDecision,
	body: string
): Promise<SessionPR | undefined> {
	const pr = requirePr(id);
	await ghAction(reviewArgs(pr, decision, body));
	return refreshPr(id);
}

function mergeArgs(pr: SessionPR, method: MergeMethod, deleteBranch: boolean): string[] {
	const args = ['pr', 'merge', String(pr.number), '-R', pr.repo, MERGE_FLAG[method]];
	if (deleteBranch) args.push('--delete-branch');
	return args;
}

// Merge the session's own PR with the chosen method (and optional branch delete),
// then refresh so the chip flips to merged immediately.
export async function mergePr(
	id: string,
	method: MergeMethod,
	deleteBranch: boolean
): Promise<SessionPR | undefined> {
	const pr = requirePr(id);
	await ghAction(mergeArgs(pr, method, deleteBranch));
	return refreshPr(id);
}
