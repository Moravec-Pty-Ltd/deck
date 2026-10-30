import type { AgentIssue, AgentPr, DeckSession, Issue, Project, PullRequest } from '$lib/types';
import { publicCost, type AgentSessionDigest } from '$lib/session-view';
import { isAgentKind } from '$lib/types';
import { baseUrl } from './config';
import { sessionLastResult, transcriptContext, transcriptCostSummary } from './transcript';
import type { ContextUsage } from '$lib/context-core';
import { activeWatches } from './watch-store';

// A session that has produced no figures yet carries no `context` at all,
// rather than a `{ used: 0, window: 0 }` a consumer would have to special-case.
function definedContext(id: string): ContextUsage | undefined {
	const context = transcriptContext(id);
	return context.used > 0 || context.window > 0 ? context : undefined;
}

// Omitted rather than undefined when unset, so they only appear on a session
// that carries them.
function runtimeFields(s: DeckSession): Pick<AgentSessionDigest, 'provider' | 'permissionMode'> {
	return {
		...(s.provider ? { provider: s.provider } : {}),
		...(s.permissionMode ? { permissionMode: s.permissionMode } : {})
	};
}

function shellFlags(s: DeckSession): Pick<AgentSessionDigest, 'managed' | 'attached'> {
	if (s.kind !== 'shell') return {};
	return {
		...(s.managed !== undefined ? { managed: s.managed } : {}),
		...(s.attached !== undefined ? { attached: s.attached } : {})
	};
}

function watchesField(id: string): Pick<AgentSessionDigest, 'watches'> {
	const watches = activeWatches(id);
	return watches.length ? { watches } : {};
}

export function sessionDigest(s: DeckSession, opts?: { lastResult?: boolean }): AgentSessionDigest {
	return {
		id: s.id,
		url: `${baseUrl}/s/${s.id}`,
		kind: s.kind,
		title: s.title,
		cwd: s.cwd,
		status: s.status,
		awaitingInput: !!s.awaitingInput,
		createdAt: s.createdAt,
		lastActiveAt: s.lastActiveAt,
		model: s.model,
		account: s.account,
		effort: s.effort,
		...runtimeFields(s),
		...shellFlags(s),
		worktree: s.worktree,
		issues: s.issues ?? (s.issue ? [s.issue] : undefined),
		pr: s.pr,
		hidden: s.hidden || undefined,
		unread: s.unread || undefined,
		// Cheap: transcriptCostSummary is LRU-cached and extended incrementally.
		cost: isAgentKind(s.kind) ? publicCost(transcriptCostSummary(s.id)) : undefined,
		// Same: one bounded tail read, cached against the file's size and mtime.
		context: isAgentKind(s.kind) ? definedContext(s.id) : undefined,
		lastResult: opts?.lastResult && isAgentKind(s.kind) ? sessionLastResult(s.id) : undefined,
		...watchesField(s.id)
	};
}

// ---- Discovery projections (issue #144) ----
// Stable agent-namespace views of the internal Project / Issue / PullRequest
// rows, so the contract doesn't couple to their full stored shapes (dev config,
// sources, sync internals). Each maps directly onto a field the create / review
// calls accept.

export interface AgentProject {
	path: string;
	name: string;
	group?: string;
	// True when the project and its sessions are in the "Hidden" section.
	// Omitted when it isn't.
	hidden?: boolean;
}

// The { path, name, group } an orchestrator needs to pick a valid `cwd`.
export function projectDigest(p: Project): AgentProject {
	return { path: p.path, name: p.name, group: p.group, hidden: p.hidden || undefined };
}

export function issueDigest(i: Issue): AgentIssue {
	return {
		source: i.sourceType,
		sourceId: i.sourceId,
		id: i.id,
		title: i.title,
		url: i.url,
		updatedAt: i.updatedAt,
		blockers: i.blockers
	};
}

export function prDigest(p: PullRequest): AgentPr {
	return {
		sourceId: p.sourceId,
		repo: p.repo,
		number: p.number,
		title: p.title,
		url: p.url,
		headRefName: p.headRefName,
		baseRefName: p.baseRefName,
		isDraft: p.isDraft,
		author: p.author,
		updatedAt: p.updatedAt
	};
}
