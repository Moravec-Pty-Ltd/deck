// Pure GitHub PR-link detection, shared by the server-side capture hook
// (appendEvent) and the one-time backfill scan. Node-free and unit-tested per
// the repo convention so the regex logic stays verifiable in isolation.
import type { PrMergeable, PrMergeStateStatus, PrReviewDecision, PrState, SessionPR } from './types';

export interface PrMatch {
	url: string;
	// owner/repo, e.g. "acme/web".
	repo: string;
	number: number;
}

// github.com pull URLs only for v1: https://github.com/<owner>/<repo>/pull/<n>.
// owner/repo use GitHub's name charset ([A-Za-z0-9._-]); the number is bounded
// (1-9 digits, with a no-more-digits lookahead) so it stays a safe integer and a
// garbage run of digits is rejected rather than truncated. The number stops at
// the first non-digit, so a fragment/suffix (#discussion_r..., /files) or a
// closing quote in serialized JSON is naturally excluded. GitLab MRs, Bitbucket,
// and self-hosted/enterprise hosts are out of scope (host is pinned to
// github.com, so github.example.com and www.github.com don't match).
const PR_URL = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d{1,9})(?!\d)/g;

// The last GitHub PR URL in `text`, or null. Last-wins: an agent may print
// several links across a session (a push hint, then the opened PR), and the most
// recently seen one is the session's current PR.
export function lastPrLink(text: string): PrMatch | null {
	let last: PrMatch | null = null;
	for (const m of text.matchAll(PR_URL)) {
		last = { url: m[0], repo: `${m[1]}/${m[2]}`, number: Number(m[3]) };
	}
	return last;
}

// gh reports terminal states (MERGED/CLOSED) and OPEN; draft is a separate flag
// that only qualifies an open PR. Anything else (an unexpected state string)
// maps to null so the caller leaves the chip neutral rather than guessing.
const PR_STATES: Record<string, PrState> = { MERGED: 'merged', CLOSED: 'closed', OPEN: 'open' };

// Map `gh pr view --json state,isDraft` onto the chip's state.
export function mapPrState(state: string, isDraft: boolean): PrState | null {
	const base = PR_STATES[state] ?? null;
	if (base === 'open' && isDraft) return 'draft';
	return base;
}

// Whether deck owns the worktree's branch and should delete it on teardown.
// True when the `worktree add` (or the pr/<n> fetch) created the branch, so the
// flag is authoritative for work sessions and for review sessions created after
// createdBranch started recording fetch ownership. The pr/<n> fallback is the
// migration for review sessions stored before that fix (they carry `false`
// forever): a worktree parked on the exact pr/<n> ref for this session's captured
// PR is a deck-fetched review ref, so recover ownership from the ref name. The
// git branch -D on delete tolerates a ref another worktree still holds, so a
// shared PR ref only drops once the last review session on it is removed.
export function ownsWorktreeBranch(
	worktree: { branch: string; createdBranch: boolean },
	pr: { number: number } | undefined
): boolean {
	if (worktree.createdBranch) return true;
	return pr !== undefined && worktree.branch === `pr/${pr.number}`;
}

// Standard GitHub state colours, applied literally (not theme tokens) so the
// chip reads the same open/merged/closed/draft as GitHub itself.
export const PR_STATE_COLOR: Record<PrState, string> = {
	open: '#1f883d',
	merged: '#8250df',
	closed: '#cf222e',
	draft: '#6e7781'
};

// Review-tally colours: approvals green, change-requests red (the same GitHub
// open/closed hues), reused by the header tally and the action menu.
export const REVIEW_COLOR = { approve: PR_STATE_COLOR.open, changes: PR_STATE_COLOR.closed };

// --- Merge policy (shared by PrMenu's gate and the server merge route) ---------
// Pure so both sides agree and the safety logic is unit-testable.

// Whether deck should let you merge this captured PR: only your own, since deck
// also captures PRs you're only reviewing. An unknown author (an older captured
// PR, not re-synced) or an unresolved viewer identity falls back to allowed, so
// the guard applies only once both are known.
export function canMergePr(pr: Pick<SessionPR, 'author'>, me: string | null): boolean {
	return !pr.author || !me || pr.author === me;
}

// Whether the merge must force past branch protection (gh pr merge --admin): only
// when the PR is actually BLOCKED (e.g. self-review disallowed). Read from synced
// state, never trusted from the client, so an unblocked PR never gets --admin.
export function shouldAdminMerge(pr: Pick<SessionPR, 'mergeStateStatus'>): boolean {
	return pr.mergeStateStatus === 'BLOCKED';
}

// --- On-open refresh gate (server/pr.ts) ---------------------------------
// Opening a session fires a single-PR refresh so the chip is fresh on open
// rather than reflecting the last 75s background tick. Dedupe window off
// `checkedAt` so flicking between sessions doesn't storm gh.
export const PR_OPEN_REFRESH_TTL_MS = 10_000;

// Whether opening a session should re-fetch its captured PR. Skips sessions with
// no PR and terminal (`merged`) PRs (mirrors nonTerminalPrItems), and dedupes
// within the TTL off the last sync's `checkedAt`. A captured-but-never-synced PR
// (no checkedAt) always refreshes.
export function shouldRefreshPrOnOpen(pr: SessionPR | undefined, now: number): boolean {
	if (!pr || pr.state === 'merged') return false;
	if (pr.checkedAt !== undefined && now - pr.checkedAt < PR_OPEN_REFRESH_TTL_MS) return false;
	return true;
}

// --- Bulk status sync (server/pr.ts) -------------------------------------
// The pure query-build + response-parse halves of the background sync live here
// (node-free, unit-tested); server/pr.ts runs the `gh` call and the store writes.

export interface PrRef {
	repo: string;
	number: number;
}

// The synced fields merged onto a stored SessionPR each tick.
export type PrSyncPatch = Pick<
	SessionPR,
	'state' | 'mergeable' | 'mergeStateStatus' | 'reviewDecision' | 'approvals' | 'changesRequested' | 'author'
>;

const PR_FIELDS =
	'state isDraft mergeable mergeStateStatus reviewDecision author{login} latestReviews(first:100){nodes{state}}';

// One aliased GraphQL selection per captured PR, so a single request covers every
// non-terminal PR across all repos. Aliases are positional (p0, p1, ...) and the
// caller maps them back by index. owner/repo come from a captured URL (charset
// [\w.-], see PR_URL), so they need no escaping inside the string literals.
export function buildPrSyncQuery(refs: PrRef[]): string {
	const aliases = refs.map((r, i) => {
		const [owner, name] = r.repo.split('/');
		return `p${i}: repository(owner:"${owner}", name:"${name}") { pullRequest(number:${r.number}) { ${PR_FIELDS} } }`;
	});
	return `query {\n${aliases.join('\n')}\n}`;
}

// Count latest-per-reviewer approvals and change-requests; COMMENTED / DISMISSED
// reviews don't move the tally. `latestReviews` is already one node per reviewer.
export function reviewCounts(nodes: { state: string }[]): {
	approvals: number;
	changesRequested: number;
} {
	let approvals = 0;
	let changesRequested = 0;
	for (const n of nodes) {
		if (n.state === 'APPROVED') approvals++;
		else if (n.state === 'CHANGES_REQUESTED') changesRequested++;
	}
	return { approvals, changesRequested };
}

interface GhPrNode {
	state: string;
	isDraft: boolean;
	mergeable: string;
	mergeStateStatus: string;
	reviewDecision: string | null;
	author: { login: string } | null;
	latestReviews?: { nodes: { state: string }[] };
}

const MERGEABLE = new Set<string>(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']);
const MERGE_STATES = new Set<string>([
	'BEHIND',
	'BLOCKED',
	'CLEAN',
	'DIRTY',
	'DRAFT',
	'HAS_HOOKS',
	'UNKNOWN',
	'UNSTABLE'
]);
const DECISIONS = new Set<string>(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']);

const pickMergeable = (v: string): PrMergeable | undefined =>
	MERGEABLE.has(v) ? (v as PrMergeable) : undefined;
const pickMergeState = (v: string): PrMergeStateStatus | undefined =>
	MERGE_STATES.has(v) ? (v as PrMergeStateStatus) : undefined;
const pickDecision = (v: string | null): PrReviewDecision | null =>
	v && DECISIONS.has(v) ? (v as PrReviewDecision) : null;

function prPatch(node: GhPrNode | undefined): PrSyncPatch | null {
	if (!node) return null;
	const state = mapPrState(node.state, node.isDraft);
	return {
		state: state ?? undefined,
		mergeable: pickMergeable(node.mergeable),
		mergeStateStatus: pickMergeState(node.mergeStateStatus),
		reviewDecision: pickDecision(node.reviewDecision),
		author: node.author?.login,
		...reviewCounts(node.latestReviews?.nodes ?? [])
	};
}

// Map a bulk-sync GraphQL response back onto the positional refs. A missing alias
// or null pullRequest (deleted repo, lost access, partial error) yields null at
// that index, so the caller leaves that PR's last-known state untouched.
export function parsePrSyncResponse(raw: string, count: number): (PrSyncPatch | null)[] {
	let data: Record<string, { pullRequest?: GhPrNode | null } | null>;
	try {
		data = JSON.parse(raw)?.data ?? {};
	} catch {
		data = {};
	}
	return Array.from({ length: count }, (_, i) => prPatch(data[`p${i}`]?.pullRequest ?? undefined));
}
