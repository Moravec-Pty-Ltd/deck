// The web UI's view of workflow runs (issue #233): colour maps, the start form's
// issue/PR reference parsing, graph ordering and loop-back edges, which controls
// a status allows, and the shared fetch/poll helpers both run pages use.
// Node-free so it is unit-tested.
import { DONE, type DecisionBy, type PhaseStatus, type RunPhaseDigest, type RunStatus, type WorkflowCategory, type WorkflowDef } from './workflows';
import type { IssueSourceType } from './types';

// Row accent (a left border) and status badge per run status. Every status also
// carries a text label, so state never rides on hue alone.
export const RUN_STATUS_VIEW: Record<RunStatus, { label: string; accent: string; badge: string }> = {
	running: { label: 'running', accent: 'border-l-primary', badge: 'badge-primary' },
	waiting: { label: 'waiting', accent: 'border-l-primary/60', badge: 'badge-primary badge-outline' },
	blocked: { label: 'blocked', accent: 'border-l-warning', badge: 'badge-warning' },
	done: { label: 'done', accent: 'border-l-success', badge: 'badge-success badge-outline' },
	paused: { label: 'paused', accent: 'border-l-base-300', badge: 'badge-ghost' },
	cancelled: { label: 'cancelled', accent: 'border-l-base-300', badge: 'badge-ghost' }
};

// Fill for a phase strip segment and a graph node's status edge. Pending is an
// outline only, so the strip still reads in monochrome.
export const PHASE_STATUS_VIEW: Record<PhaseStatus, { label: string; fill: string; node: string }> = {
	pending: { label: 'pending', fill: 'border border-base-content/30', node: 'border-base-300' },
	active: { label: 'active', fill: 'bg-primary phase-pulse', node: 'border-primary border-2' },
	pass: { label: 'passed', fill: 'bg-success', node: 'border-success' },
	fail: { label: 'failed', fill: 'bg-error', node: 'border-error border-dashed' },
	skipped: { label: 'skipped', fill: 'bg-base-content/20', node: 'border-base-300 border-dotted' }
};

export const DECISION_BADGE: Record<DecisionBy, string> = {
	overseer: 'badge-secondary',
	human: 'badge-neutral',
	engine: 'badge-ghost'
};

// ---- Controls ----

export type RunControl = 'pause' | 'takeover' | 'resume' | 'retry' | 'cancel';

const CONTROLS: Record<RunStatus, readonly RunControl[]> = {
	running: ['pause', 'takeover', 'resume', 'cancel'],
	waiting: ['pause', 'takeover', 'resume', 'cancel'],
	blocked: ['takeover', 'resume', 'retry', 'cancel'],
	paused: ['takeover', 'resume', 'retry', 'cancel'],
	done: [],
	cancelled: []
};

export function allowedControls(status: RunStatus): ReadonlySet<RunControl> {
	return new Set(CONTROLS[status]);
}

// ---- Start form ----

export interface IssueRef {
	source: IssueSourceType;
	id: string;
	url?: string;
}

export interface PrRefInput {
	repo: string;
	number: number;
	url?: string;
}

const REPO = '([\\w.-]+/[\\w.-]+)';
const GH_SHORT = new RegExp(`^${REPO}#(\\d+)$`);
const GH_ISSUE_URL = new RegExp(`^https?://github\\.com/${REPO}/issues/(\\d+)(?:[/?#].*)?$`);
const GH_PR_URL = new RegExp(`^https?://github\\.com/${REPO}/pull/(\\d+)(?:[/?#].*)?$`);
const LINEAR_ID = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const LINEAR_URL = /^https?:\/\/linear\.app\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:[/?#].*)?$/;

// `owner/repo#123`, a GitHub issue URL, a Linear id (`ABC-123`), or a Linear
// issue URL. null for anything else, so the form can say so before posting.
export function parseIssueRef(input: string): IssueRef | null {
	const text = input.trim();
	const gh = text.match(GH_SHORT) ?? text.match(GH_ISSUE_URL);
	if (gh) return { source: 'github', id: `${gh[1]}#${gh[2]}`, url: `https://github.com/${gh[1]}/issues/${gh[2]}` };
	if (LINEAR_ID.test(text)) return { source: 'linear', id: text.toUpperCase() };
	const lin = text.match(LINEAR_URL);
	return lin ? { source: 'linear', id: lin[1].toUpperCase(), url: text } : null;
}

// A PR as `owner/repo#123` or its GitHub URL. A bare number has no repo, which
// the server needs, so it is rejected here with the rest.
export function parsePrRef(input: string): PrRefInput | null {
	const text = input.trim();
	const m = text.match(GH_PR_URL) ?? text.match(GH_SHORT);
	if (!m) return null;
	return { repo: m[1], number: Number(m[2]), url: `https://github.com/${m[1]}/pull/${m[2]}` };
}

// Workflows grouped by category for the start form's select, the default first.
export function workflowsByCategory(workflows: WorkflowDef[]): { category: WorkflowCategory; workflows: WorkflowDef[] }[] {
	const groups = new Map<WorkflowCategory, WorkflowDef[]>();
	for (const w of workflows) groups.set(w.category, [...(groups.get(w.category) ?? []), w]);
	return [...groups].map(([category, list]) => ({
		category,
		workflows: [...list].sort((a, b) => Number(!!b.default) - Number(!!a.default))
	}));
}

// The workflow the form starts on: the dev default, else the first one.
export function defaultWorkflow(workflows: WorkflowDef[]): WorkflowDef | undefined {
	return workflows.find((w) => w.default && w.category === 'dev') ?? workflows.find((w) => w.default) ?? workflows[0];
}

export function basename(path: string): string {
	return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
}

// ---- Graph ----

// Chain order: walk `next` from the entry step, then append any step the happy
// path never reaches (fix, arbiter) in definition order.
export function chainOrder(phases: RunPhaseDigest[]): RunPhaseDigest[] {
	const byId = new Map(phases.map((p) => [p.id, p]));
	const seen = new Set<string>();
	let cursor = phases[0];
	while (cursor && !seen.has(cursor.id)) {
		seen.add(cursor.id);
		cursor = byId.get(cursor.next)!;
	}
	const chain = [...seen].map((id) => byId.get(id)!);
	return [...chain, ...phases.filter((p) => !seen.has(p.id))];
}

export interface GraphEdge {
	from: string;
	to: string;
	kind: 'fail' | 'next';
	// Columns in chain order, so the connector can span them.
	fromIndex: number;
	toIndex: number;
	back: boolean;
}

function edgeTo(order: string[], from: string, to: string | undefined, kind: GraphEdge['kind']): GraphEdge | null {
	if (!to || to === DONE) return null;
	const fromIndex = order.indexOf(from);
	const toIndex = order.indexOf(to);
	if (toIndex === -1) return null;
	return { from, to, kind, fromIndex, toIndex, back: toIndex <= fromIndex };
}

// The edges the straight left-to-right row does not already show: every
// `onFail`, and any `next` that is not simply the following node (a fix step's
// return to verify).
export function graphEdges(ordered: RunPhaseDigest[]): GraphEdge[] {
	const order = ordered.map((p) => p.id);
	const edges: GraphEdge[] = [];
	for (const p of ordered) {
		const fail = edgeTo(order, p.id, p.onFail, 'fail');
		const next = edgeTo(order, p.id, p.next, 'next');
		if (fail) edges.push(fail);
		if (next && next.toIndex !== next.fromIndex + 1) edges.push(next);
	}
	return edges;
}

// A node's visit badge: `2/5` against a cap, `x2` with no cap, nothing for a
// single uncapped visit.
export function visitBadge(phase: Pick<RunPhaseDigest, 'visits' | 'cap'>): string | null {
	if (phase.cap) return `${phase.visits}/${phase.cap}`;
	return phase.visits > 1 ? `x${phase.visits}` : null;
}

// Review-like phases count rounds; everything else counts visits.
export function visitLabel(phase: Pick<RunPhaseDigest, 'cap'>, visit: number): string {
	return `${phase.cap ? 'Round' : 'Visit'} ${visit}`;
}

// ---- Fetch and poll ----

// JSON from a deck endpoint, throwing the server's `{ message }` on a non-2xx.
export async function api<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
	const init: RequestInit =
		body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
	const res = await fetch(url, init);
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data?.message ?? `request failed (${res.status})`);
	return data as T;
}

interface VisibilityDoc {
	hidden: boolean;
	addEventListener(type: 'visibilitychange', fn: () => void): void;
	removeEventListener(type: 'visibilitychange', fn: () => void): void;
}

// Run `tick` now and every `ms` while the page is visible; a hidden page stops
// the timer and a return to visible ticks at once. Returns the cleanup.
export function pollWhileVisible(tick: () => void, ms: number, doc: VisibilityDoc = document): () => void {
	let timer: ReturnType<typeof setInterval> | undefined;
	const stop = () => {
		clearInterval(timer);
		timer = undefined;
	};
	const sync = () => {
		stop();
		if (doc.hidden) return;
		tick();
		timer = setInterval(tick, ms);
	};
	sync();
	doc.addEventListener('visibilitychange', sync);
	return () => {
		stop();
		doc.removeEventListener('visibilitychange', sync);
	};
}
