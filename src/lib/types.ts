export type SessionKind = 'claude' | 'pi' | 'codex' | 'shell';
export type SessionStatus = 'running' | 'idle' | 'error' | 'dead';

// Agent kinds drive an LLM coding agent (chat view); 'shell' is a tmux terminal.
export function isAgentKind(kind: SessionKind): kind is Exclude<SessionKind, 'shell'> {
	return kind !== 'shell';
}

export interface DeckSession {
	id: string;
	kind: SessionKind;
	title: string;
	cwd: string;
	createdAt: number;
	lastActiveAt: number;
	status: SessionStatus;
	// agents (claude/pi/codex)
	claudeSessionId?: string;
	// resume handle for pi/codex (pi session-file path, codex thread id)
	agentSessionId?: string;
	model?: string;
	provider?: string;
	permissionMode?: 'acceptEdits' | 'bypassPermissions' | 'default' | 'plan';
	// shell
	tmuxName?: string;
	managed?: boolean;
	attached?: boolean;
	// set when deck created this session inside a git worktree. `base` is the ref
	// the worktree was branched from, kept so the diff viewer can resolve "changes
	// since base" without guessing.
	worktree?: { repo: string; branch: string; createdBranch: boolean; base?: string };
	// set when the session was started from an issue picked in the new-session modal
	issue?: SessionIssue;
	// the most recent GitHub PR link seen in the transcript (last-wins), captured
	// server-side in appendEvent and surfaced as a header chip. Like `issue`, this
	// is metadata, not a live handle: deck doesn't track PR state.
	pr?: SessionPR;
	// set once the one-time historical PR scan has run for this session, so it
	// doesn't repeat on every open and a dismissed `pr` isn't resurrected from the
	// transcript on reload (see getSession backfill).
	prBackfilled?: boolean;
}

// Live GitHub state of a captured PR, mapped from a PR's state + isDraft (see
// lib/pr.ts). Coloured with the standard GitHub palette in the header chip and
// the sidebar worktree icon.
export type PrState = 'open' | 'merged' | 'closed' | 'draft';

// Mergeability and review-decision enums, passed through verbatim from GitHub's
// GraphQL PR object so the chip/menu can gate the Merge action and show a verdict.
export type PrMergeable = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
export type PrReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED';

// A captured GitHub PR link plus its last-synced live state. `repo` is owner/repo;
// `number` and `url` come from the github.com/<owner>/<repo>/pull/<n> match (see
// lib/pr.ts). Everything below `seenAt` is filled by the background bulk sync
// (server/pr.ts) and persists, so reopening shows the last-known colour, tally,
// and merge-ability instantly. `approvals`/`changesRequested` are latest-per-
// reviewer counts from the PR's reviews. A captured-but-never-synced PR has only
// the first four fields.
export interface SessionPR {
	url: string;
	repo: string;
	number: number;
	seenAt: number;
	state?: PrState;
	checkedAt?: number;
	mergeable?: PrMergeable;
	reviewDecision?: PrReviewDecision | null;
	approvals?: number;
	changesRequested?: number;
}

// The issue a session was launched from, persisted so the header can deep-link
// back to the original ticket. deck is read-only on sources: this is metadata,
// not a live handle.
export interface SessionIssue {
	source: IssueSourceType;
	id: string;
	url: string;
}

export interface Project {
	name: string;
	path: string;
	// Optional grouping label (issue #34). Projects sharing the string cluster
	// together in the lists/pickers; absent falls into the "Ungrouped" bucket.
	// Single group per project, no separate entity, no migration.
	group?: string;
	template?: string;
	lastBase?: string;
	// Issue sources are per-project and additive. API keys never live here; they
	// sit in ~/.deck/secrets.json keyed by source id (see server/store.ts).
	sources?: IssueSource[];
	// Dev-server standup config (issue #32): copy env files in, run ordered setup,
	// then launch one or more monitored dev commands on an agent session's worktree.
	dev?: DevConfig;
}

// A port a dev server listens on. `primary` marks which one the preview link
// opens; `label` is shown in the UI for multi-port stacks.
export interface PortSpec {
	port: number;
	label?: string;
	primary?: boolean;
}

// One ordered, idempotent setup step. `cwd` is relative to the worktree root so a
// subdirectory build is just a step. `run` executes through the pane's shell.
export interface SetupStep {
	label: string;
	run: string;
	cwd?: string;
}

// A long-running dev command, independently start/stop/restartable and monitored.
export interface ServerSpec {
	name: string;
	run: string;
	cwd?: string;
	setup?: SetupStep[];
	ports?: PortSpec[];
	readyPattern?: string;
}

// Per-project dev config, stored on the project (see store.ts), validated with
// zod on write (see server/devservers-core.ts).
export interface DevConfig {
	copyFromMain?: string[];
	setup?: SetupStep[];
	servers?: ServerSpec[];
}

// Health a managed dev server is in. setup -> starting -> running, with stalled /
// errored / dead / stopped as the off-happy-path states.
export type ServerState =
	| 'stopped'
	| 'setup'
	| 'starting'
	| 'running'
	| 'stalled'
	| 'errored'
	| 'dead';

export type SetupStepState = 'pending' | 'running' | 'ok' | 'failed';

// Progress of a single setup step, surfaced live while a server is being started.
export interface SetupStepProgress {
	label: string;
	state: SetupStepState;
	exitCode?: number;
	output?: string;
}

// A configured port plus its live listening status, for the Servers tab.
export interface PortStatus {
	port: number;
	label?: string;
	primary?: boolean;
	listening: boolean;
}

// Live view of a configured server: its derived state, ports, preview URL, and
// the progress of its last setup run.
export interface ServerRuntime {
	name: string;
	state: ServerState;
	tmuxName: string;
	ports: PortStatus[];
	previewUrl?: string;
	setup: SetupStepProgress[];
	error?: string;
	// Non-fatal: a port is held by a process deck didn't start (it may fail to bind).
	warning?: string;
}

export type IssueSourceType = 'github' | 'linear' | 'clickup';

// owner/repo, one bounded scope. Filter is hard-coded to open + assigned to the
// authenticated `gh` user, so there is no config and no stored secret.
export interface GithubSource {
	id: string;
	type: 'github';
	owner: string;
	repo: string;
}

// Team-scoped. apiKey lives in secrets.json; assignee is always "me".
export interface LinearSource {
	id: string;
	type: 'linear';
	teamId: string;
	teamName: string;
	assigneeEmail: string;
	stateIds: string[];
}

// List-scoped, reached through a team → space → folder? → list cascade.
// apiKey lives in secrets.json; assignee is always "me".
export interface ClickupSource {
	id: string;
	type: 'clickup';
	teamId: string;
	teamName: string;
	spaceId: string;
	spaceName: string;
	folderId?: string;
	folderName?: string;
	listId: string;
	listName: string;
	statuses: string[];
	assigneeUserId: number;
}

export type IssueSource = GithubSource | LinearSource | ClickupSource;

export interface IssueBlocker {
	id: string;
	title: string;
}

// A normalised issue across all three sources, as surfaced in the picker.
// `id` is the bare short ref (owner/repo#42, LIN-123, #abc123) that flows into
// the session title; `blockers` are the incomplete direct blockers (shallow).
export interface Issue {
	sourceId: string;
	sourceType: IssueSourceType;
	id: string;
	title: string;
	url: string;
	updatedAt: number;
	blockers: IssueBlocker[];
}

// Prefilled values for the new-session modal when launched from a shortcut
// (sidebar quick-add, "shell in this worktree", etc.).
export interface NewSessionPreset {
	kind?: SessionKind;
	projectPath?: string;
	cwd?: string;
	title?: string;
}
