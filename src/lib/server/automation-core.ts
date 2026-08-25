// Pure trigger-key + dedupe logic and the /api/sessions request bodies for feed
// automation (issue #171), kept node-free so they unit-test without fs/gh. The
// orchestration (feed fetch, session create, notify, durable ledger) lives in the
// sibling automation.ts.
import { z } from 'zod';
import { shortIssueId } from '$lib/issues';
import { EFFORT_LEVELS } from '$lib/effort';
import { isReviewSession } from '$lib/pr';
import { AGENT_KINDS } from '$lib/types';
import type {
	AgentKind,
	AutomationAgent,
	DeckSession,
	Issue,
	SessionStatus,
	ModelChoice,
	Project,
	PullRequest
} from '$lib/types';

// The durable ledger of trigger keys that have already spawned a session, keyed
// to their first-fired timestamp. An item lingering in a feed across polls and
// restarts is matched against this, so it never spawns twice.
export type ProcessedKeys = Record<string, number>;

// Deterministic per-issue key: source type + the issue's globally-unique id
// (owner/repo#n, LIN-123, #abc). Keyed by type, not source id, so re-adding a
// source doesn't resurrect already-processed issues.
export function workTriggerKey(issue: Pick<Issue, 'sourceType' | 'id'>): string {
	return `auto:work:${issue.sourceType}:${issue.id}`;
}

// Deterministic per-PR key, pinned to the head sha: a re-requested review comes
// back into the feed at a new head, and that must fire again (issue #209). The
// PR-only form below is the pre-#209 key shape, kept for migration and pruning.
function reviewKeyPrefix(pr: Pick<PullRequest, 'repo' | 'number'>): string {
	return `auto:review:${pr.repo}#${pr.number}`;
}
export function reviewTriggerKey(pr: Pick<PullRequest, 'repo' | 'number' | 'headRefOid'>): string {
	return `${reviewKeyPrefix(pr)}@${pr.headRefOid}`;
}

// Ledgers written before #209 hold the PR-only key, which the new shape would
// never match — so every PR still awaiting review would respawn on upgrade.
// Re-key those entries onto the head we see now (keeping their original
// timestamp): that PR is treated as already fired at its current head, and any
// later head fires normally. Returns whether the ledger changed.
export function migrateReviewKeys(
	prs: Pick<PullRequest, 'repo' | 'number' | 'headRefOid'>[],
	processed: ProcessedKeys
): boolean {
	let changed = false;
	for (const pr of prs) {
		const legacy = reviewKeyPrefix(pr);
		if (processed[legacy] === undefined) continue;
		processed[reviewTriggerKey(pr)] ??= processed[legacy];
		delete processed[legacy];
		changed = true;
	}
	return changed;
}

// Drop the entries a newly-fired review key supersedes: every other key for the
// same PR (older heads, plus a stray legacy entry). Without this the ledger grows
// one entry per push, forever. Returns whether the ledger changed.
export function pruneSupersededReviewKeys(
	processed: ProcessedKeys,
	pr: Pick<PullRequest, 'repo' | 'number' | 'headRefOid'>
): boolean {
	const legacy = reviewKeyPrefix(pr);
	const keep = reviewTriggerKey(pr);
	let changed = false;
	for (const k of Object.keys(processed)) {
		if (k === keep) continue;
		if (k !== legacy && !k.startsWith(`${legacy}@`)) continue;
		delete processed[k];
		changed = true;
	}
	return changed;
}

// `repo#number` identity of a PR, used to skip a review trigger while a session
// for that PR is still around. A PR stays in `review-requested:@me` until you
// review it, so without this every push mid-review would spawn another session.
export function prIdentity(pr: Pick<PullRequest, 'repo' | 'number'>): string {
	return `${pr.repo}#${pr.number}`;
}

// A candidate whose trigger key hasn't fired yet, paired with that key.
export interface NewTrigger<T> {
	key: string;
	candidate: T;
}

// From a batch of feed candidates, the ones whose key isn't already in
// `processed` — deduped within the batch too (a feed listing an item twice yields
// one trigger). Input order is preserved so spawns keep a stable order.
export function selectNewTriggers<T>(
	candidates: T[],
	keyOf: (c: T) => string,
	processed: ProcessedKeys
): NewTrigger<T>[] {
	const out: NewTrigger<T>[] = [];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		const key = keyOf(candidate);
		if (processed[key] !== undefined || seen.has(key)) continue;
		seen.add(key);
		out.push({ key, candidate });
	}
	return out;
}

// The agent half of an automatic session's create body (issue #223): the lane's
// configured kind/model/provider/effort, falling back to the project's own
// remembered pick for that kind (what a manual start in this project last used),
// and finally to the CLI's own default (undefined). Deliberately not the global
// `settings.lastModels` the manual picker also consults: reaching for that would
// give an automatic session a `--model` on a project that has never picked one,
// which is the "behaviour is unchanged when nothing is configured" case.
//
// The two per-kind contracts are honoured on the *fallback* only: a remembered
// provider is pi's alone and a remembered effort is claude's alone, so neither
// leaks onto a kind that would 400 on it. A configured effort is passed through
// as-is even for another kind, so the create boundary rejects it out loud rather
// than dropping it silently.
export function agentFields(project: Project, agent: AutomationAgent = {}): Record<string, unknown> {
	const kind = agent.kind ?? 'claude';
	const remembered = rememberedChoice(project, kind, agent);
	return {
		kind,
		model: agent.model || remembered.model,
		provider: agent.provider || remembered.provider,
		effort: agent.effort ?? (kind === 'claude' ? project.lastEffort : undefined)
	};
}

// The project's remembered pick to fall back on. pi's provider and model are a
// pair (a provider hosts particular models), so a lane naming either half must not
// inherit the other from whatever provider was last used; the other kinds carry
// the whole id in `model` and have no provider to leak.
function rememberedChoice(project: Project, kind: AgentKind, agent: AutomationAgent): Partial<ModelChoice> {
	const remembered: Partial<ModelChoice> = project.lastModels?.[kind] ?? {};
	if (kind !== 'pi') return { model: remembered.model };
	return agent.model || agent.provider ? {} : remembered;
}

// The /api/sessions body for a work session, mirroring the New Session modal's
// per-issue split: titled with the issue's display id and run in a fresh worktree whose
// branch is the issue id, off the project's remembered base (repo default when
// unset), never the project checkout itself. Seeded with the project's `template`
// (blank-safe: an empty prompt just leaves the session idle, like the UI). `issue`
// mirrors the picker's shape (source, not sourceType) so parseIssue accepts it. If
// the issue-id branch already exists, the worktree add throws and spawn releases
// the claim rather than clobbering it.
export function workBody(project: Project, issue: Issue): Record<string, unknown> {
	return {
		...agentFields(project, project.automation?.workAgent),
		cwd: project.path,
		title: shortIssueId(issue.sourceType, issue.id),
		prompt: project.template ?? '',
		issue: { source: issue.sourceType, id: issue.id, url: issue.url, sourceId: issue.sourceId },
		worktree: { branch: issue.id, newBranch: true, base: project.lastBase || undefined }
	};
}

// The /api/sessions body for a review session, mirroring the modal: titled with the
// PR title, checking the PR head into a worktree (fromPr) with the PR's base ref
// for the Changes diff, seeded with the project's `reviewPrompt`.
export function reviewBody(project: Project, pr: PullRequest): Record<string, unknown> {
	return {
		...agentFields(project, project.automation?.reviewAgent),
		cwd: project.path,
		title: pr.title,
		prompt: project.reviewPrompt ?? '',
		pr: { repo: pr.repo, number: pr.number, url: pr.url, title: pr.title },
		worktree: { fromPr: pr.number, base: pr.baseRefName }
	};
}

// How many automatic review sessions may run at once, across every project (issue
// #224). Several PRs landing together shouldn't put N agents on one machine, and
// against a local model they'd contend for the same GPU. Fixed at one; if it ever
// needs to be a dial it belongs next to the other per-project automation settings.
const REVIEW_SESSION_CAP = 1;

// A session in one of these can never free the slot: retirement needs the session
// to reach idle with a verdict (server/pr.ts), and a session whose agent died on
// its first turn never will. Counting it would wedge automatic review across every
// project until you noticed and deleted the session by hand. ('error' is the one
// that actually happens; 'dead' is only ever derived for a shell.)
const STUCK: SessionStatus[] = ['dead', 'error'];

// Whether the cap is reached, counted fresh from the session store so a restart, a
// manual delete, or a retirement can't desync it. Counts *review* sessions only
// (isReviewSession: a captured PR parked on that PR's `pr/<n>` ref), so a work
// session that happens to have captured its own PR link doesn't hold the slot.
// Manually-started reviews do count: the point is one review on the machine.
export function atReviewCap(sessions: Pick<DeckSession, 'status' | 'worktree' | 'pr'>[]): boolean {
	const held = sessions.filter((s) => !STUCK.includes(s.status) && isReviewSession(s));
	return held.length >= REVIEW_SESSION_CAP;
}

// Review candidates in drain order: oldest-updated first. The feed arrives
// newest-first, which under a cap of one and a steady stream of pushes would let
// an older PR wait indefinitely. Takes the timestamp by getter because the queue
// that gets ordered is merged across projects, not a bare feed.
export function reviewOrder<T>(items: T[], updatedAt: (item: T) => number): T[] {
	return [...items].sort((a, b) => updatedAt(a) - updatedAt(b));
}

// --- Per-project automation config (issue #223) ---

function blankToUndefined(v: string | undefined): string | undefined {
	return v || undefined;
}

// One lane's agent pick as the settings form sends it. Every field is optional,
// and a blank string means unset rather than "the empty model".
const agentSchema = z
	.object({
		kind: z.enum(AGENT_KINDS).optional(),
		model: z.string().trim().optional().transform(blankToUndefined),
		provider: z.string().trim().optional().transform(blankToUndefined),
		effort: z.enum(EFFORT_LEVELS).optional()
	})
	// The same two per-kind contracts the create boundary enforces, checked here so
	// a mismatch surfaces in the settings form instead of failing every later tick.
	.refine((a) => !a.provider || (a.kind ?? 'claude') === 'pi', {
		message: 'provider is only valid for pi sessions'
	})
	.refine((a) => !a.effort || (a.kind ?? 'claude') === 'claude', {
		message: 'effort is only valid for claude sessions'
	});

const automationSchema = z.object({
	work: z.boolean().optional(),
	review: z.boolean().optional(),
	workAgent: agentSchema.optional(),
	reviewAgent: agentSchema.optional()
});

// A lane that says nothing collapses to absent, so projects.json stays tidy for a
// project that only ever ticked the toggle.
function toAgent(agent: AutomationAgent | undefined): AutomationAgent | undefined {
	if (!agent) return undefined;
	return Object.values(agent).some((v) => v !== undefined) ? agent : undefined;
}

// The first schema problem as one line, e.g. `reviewAgent: effort is only valid
// for claude sessions`. zod's own `.message` is a JSON blob, which is no use in a
// settings form.
function problem(err: z.ZodError): string {
	const issue = err.issues[0];
	if (!issue) return 'invalid automation config';
	return [['automation', ...issue.path].join('.'), issue.message].join(': ');
}

// A lane's pick, carrying the stored one when the body doesn't mention the field
// at all. A stale client (an old tab, a cached PWA bundle) posts the pre-#223
// shape, and that must not silently wipe a configured lane; a field that *is*
// present and blank still clears.
function resolveAgent(
	raw: Record<string, unknown>,
	key: 'workAgent' | 'reviewAgent',
	parsed: AutomationAgent | undefined,
	existing: AutomationAgent | undefined
): AutomationAgent | undefined {
	return key in raw ? toAgent(parsed) : existing;
}

// The per-project automation config from an untyped request body, merged over
// what's stored. Throws with a one-line message on a bad shape; the all-default
// shape collapses to absent. An agent pick is kept even when its lane is off, so
// toggling the lane back on doesn't lose it.
export function parseAutomation(raw: unknown, existing?: Project['automation']): Project['automation'] {
	const parsed = automationSchema.safeParse(raw);
	if (!parsed.success) throw new Error(problem(parsed.error));
	const body = raw as Record<string, unknown>;
	const automation = {
		work: !!parsed.data.work,
		review: !!parsed.data.review,
		workAgent: resolveAgent(body, 'workAgent', parsed.data.workAgent, existing?.workAgent),
		reviewAgent: resolveAgent(body, 'reviewAgent', parsed.data.reviewAgent, existing?.reviewAgent)
	};
	return Object.values(automation).some(Boolean) ? automation : undefined;
}
