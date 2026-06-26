// Pure GitHub PR-link detection, shared by the server-side capture hook
// (appendEvent) and the one-time backfill scan. Node-free and unit-tested per
// the repo convention so the regex logic stays verifiable in isolation.
import type { PrMergeable, PrReviewDecision, PrState, SessionPR } from './types';

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
	'state' | 'mergeable' | 'reviewDecision' | 'approvals' | 'changesRequested'
>;

const PR_FIELDS =
	'state isDraft mergeable reviewDecision url latestReviews(first:100){nodes{state}}';

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
	reviewDecision: string | null;
	latestReviews?: { nodes: { state: string }[] };
}

const MERGEABLE = new Set<string>(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']);
const DECISIONS = new Set<string>(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']);

const pickMergeable = (v: string): PrMergeable | undefined =>
	MERGEABLE.has(v) ? (v as PrMergeable) : undefined;
const pickDecision = (v: string | null): PrReviewDecision | null =>
	v && DECISIONS.has(v) ? (v as PrReviewDecision) : null;

function prPatch(node: GhPrNode | undefined): PrSyncPatch | null {
	if (!node) return null;
	const state = mapPrState(node.state, node.isDraft);
	return {
		state: state ?? undefined,
		mergeable: pickMergeable(node.mergeable),
		reviewDecision: pickDecision(node.reviewDecision),
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
