export type SessionKind = 'claude' | 'pi' | 'codex' | 'opencode' | 'shell';
export type SessionStatus = 'running' | 'idle' | 'error' | 'dead';

// Agent kinds drive an LLM coding agent (chat view); 'shell' is a tmux terminal.
export type AgentKind = Exclude<SessionKind, 'shell'>;
export function isAgentKind(kind: SessionKind): kind is AgentKind {
	return kind !== 'shell';
}

// A picked model for an agent session. `provider` is only meaningful for pi
// (its separate --provider arg); claude/codex/opencode carry the whole id in
// `model` (opencode's is a combined `provider/model`).
export interface ModelChoice {
	provider?: string;
	model: string;
}

export interface DeckSession {
	id: string;
	kind: SessionKind;
	title: string;
	cwd: string;
	createdAt: number;
	lastActiveAt: number;
	status: SessionStatus;
	// true while the session is blocked on an MCP `ask` (a pending entry in the ask
	// map, see server/ask.ts). Derived per /api/sessions poll so the sidebar's
	// status view can bucket it under "Needs attention" (issue #48).
	awaitingInput?: boolean;
	// agents (claude/pi/codex/opencode)
	claudeSessionId?: string;
	// resume handle for pi/codex/opencode (pi session-file path, codex thread id,
	// opencode session id)
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
	// set when the session was started from an issue picked in the new-session modal.
	// `issue` is the legacy single-issue field, still read for sessions stored
	// before multi-issue; new sessions write `issues` (one chip per entry in the
	// header). Read them together: `issues ?? (issue ? [issue] : [])`.
	issue?: SessionIssue;
	issues?: SessionIssue[];
	// the most recent GitHub PR link seen in the transcript (last-wins), captured
	// server-side in appendEvent and surfaced as a header chip. Like `issue`, this
	// is metadata, not a live handle: deck doesn't track PR state.
	pr?: SessionPR;
	// set once the one-time historical PR scan has run for this session, so it
	// doesn't repeat on every open and a dismissed `pr` isn't resurrected from the
	// transcript on reload (see getSession backfill).
	prBackfilled?: boolean;
	// state of the workflow run attached to this session, if any (issue #111).
	// Written by the server runner on every step transition; read by the session
	// view's progress strip via the /api/sessions poll.
	workflowRun?: WorkflowRun;
}

// Live GitHub state of a captured PR, mapped from a PR's state + isDraft (see
// lib/pr.ts). Coloured with the standard GitHub palette in the header chip and
// the sidebar worktree icon.
export type PrState = 'open' | 'merged' | 'closed' | 'draft';

// Mergeability and review-decision enums, passed through verbatim from GitHub's
// GraphQL PR object so the chip/menu can gate the Merge action and show a verdict.
export type PrMergeable = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
export type PrReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED';
// GitHub's mergeStateStatus: whether a mergeable PR is actually mergeable *now*.
// `BLOCKED` means branch protection is holding it (e.g. self-review disallowed),
// which is where the Merge button offers a force (admin) merge.
export type PrMergeStateStatus =
	| 'BEHIND'
	| 'BLOCKED'
	| 'CLEAN'
	| 'DIRTY'
	| 'DRAFT'
	| 'HAS_HOOKS'
	| 'UNKNOWN'
	| 'UNSTABLE';

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
	// PR title, set when a session is started in Review mode (server sync doesn't
	// fetch it, so it's only present for review-seeded PRs). Feeds [pr_title].
	title?: string;
	state?: PrState;
	checkedAt?: number;
	mergeable?: PrMergeable;
	// Whether branch protection is currently blocking an otherwise-mergeable PR;
	// `BLOCKED` drives the "Force merge" (admin) affordance in PrMenu.
	mergeStateStatus?: PrMergeStateStatus;
	reviewDecision?: PrReviewDecision | null;
	approvals?: number;
	changesRequested?: number;
	// PR author login, captured by the sync. Absent on a captured-but-never-synced
	// PR (older sessions); the own-PR merge guard treats absent as allowed.
	author?: string;
}

// The issue a session was launched from, persisted so the header can deep-link
// back to the original ticket. deck is read-only on sources: this is metadata,
// not a live handle.
export interface SessionIssue {
	source: IssueSourceType;
	id: string;
	url: string;
}

// What a workflow runs against. Drives the new-session modal (which picker to
// show, which [token] set applies) and the worktree behaviour, mirroring
// today's new/review split: 'issue' behaves like New mode, 'pr' like Review,
// 'worktree' targets an existing worktree, 'none' runs with no worktree.
export type WorkflowContext = 'issue' | 'pr' | 'worktree' | 'none';

// One step of a workflow. `run`/`gate` execute a shell command in the session
// cwd; `agent` is one turn in the session; `ask` blocks on the deck ask UI.
// Prompts, commands, and questions accept the [token] placeholders plus
// [step:<name>] for a previous step's captured output.
export type WorkflowStep =
	| { type: 'run'; name: string; command: string }
	| { type: 'agent'; name: string; prompt: string; model?: string }
	| { type: 'gate'; name: string; command: string; retries?: number }
	| { type: 'ask'; name: string; question: string };

// A named per-project automation (issue #111). Generalises the old
// template/reviewPrompt pair: those synthesize into single-agent-step
// workflows when `Project.workflows` is absent (see workflows-core.ts).
export interface Workflow {
	id: string;
	name: string;
	context: WorkflowContext;
	steps: WorkflowStep[];
}

// Where a workflow run currently is. 'awaiting-input' means blocked on an ask
// step; 'paused' means it stopped short (gate retries exhausted, a step
// failed, or the server restarted mid-run) with `reason` saying why.
export type WorkflowRunStatus =
	| 'running'
	| 'awaiting-input'
	| 'paused'
	| 'done'
	| 'cancelled';

// The step list snapshotted onto the run at start, so progress renders
// stably even if the project's workflow config is edited mid-run.
export interface WorkflowRunStep {
	name: string;
	type: WorkflowStep['type'];
}

// Run state persisted on the session (one run per session). `step` is the
// index into `steps` the run is at; retry counters live in the server runner's
// memory, so a run does not survive a server restart (it surfaces as paused).
export interface WorkflowRun {
	workflowId: string;
	name: string;
	steps: WorkflowRunStep[];
	step: number;
	status: WorkflowRunStatus;
	reason?: string;
	startedAt: number;
}

// A user-configured canned message shown in the agent composer's quick-message
// popover (issue #45). `label` is the menu label, falling back to the text when
// absent. `text` may contain [tokens] expanded server-side at send time (see
// lib/placeholders.ts). Stored system-wide in ~/.deck/quick-messages.json.
export interface QuickMessage {
	id: string;
	label?: string;
	text: string;
}

export interface Project {
	name: string;
	path: string;
	// Optional grouping label (issue #34). Projects sharing the string cluster
	// together in the lists/pickers; absent falls into the "Ungrouped" bucket.
	// Single group per project, no separate entity, no migration.
	group?: string;
	template?: string;
	// First-prompt template for Review-mode sessions (started on a PR awaiting
	// review). Empty means an empty prompt field, exactly like `template`.
	reviewPrompt?: string;
	lastBase?: string;
	// Last model picked per agent kind for this project, so the new-session modal
	// re-selects it next time (issue #51). Stored in ~/.deck, never committed.
	lastModels?: Partial<Record<AgentKind, ModelChoice>>;
	// Issue sources are per-project and additive. API keys never live here; they
	// sit in ~/.deck/secrets.json keyed by source id (see server/store.ts).
	sources?: IssueSource[];
	// Configured workflows (issue #111). Absent means the legacy
	// template/reviewPrompt fields drive the two synthesized defaults.
	workflows?: Workflow[];
	// Dev-server standup config (issue #32): copy env files in, run ordered setup,
	// then launch one or more monitored dev commands on an agent session's worktree.
	dev?: DevConfig;
	// Background feed automation (issue #171): when on, the monitor's gh tick
	// auto-spawns a session for each new matching feed item — `work` for issues
	// assigned to me in a todo-ish state, `review` for PRs awaiting my review. Both
	// default off; a given issue/PR fires at most once ever (durable dedupe in
	// ~/.deck/automation.json).
	automation?: { work?: boolean; review?: boolean };
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

// An open GitHub PR awaiting the authenticated user's review, as surfaced in the
// Review-mode PR picker. `repo` is owner/repo; `headRefName`/`baseRefName` are the
// PR's head/base branches; the worktree is checked out to a local `pr/<number>`
// ref fetched from the base repo's pull/* refs.
export interface PullRequest {
	sourceId: string;
	repo: string;
	number: number;
	title: string;
	url: string;
	headRefName: string;
	baseRefName: string;
	isDraft: boolean;
	author: string;
	updatedAt: number;
}

// Prefilled values for the new-session modal when launched from a shortcut
// (sidebar quick-add, "shell in this worktree", etc.).
export interface NewSessionPreset {
	kind?: SessionKind;
	projectPath?: string;
	cwd?: string;
	title?: string;
}

// One harness's row in the projects page's Agent skills panel (issue #127):
// the shipped deck skill's install/version status. `supported` is whether deck
// knows where that harness keeps skills; unsupported rows render as such
// rather than blocking the panel. Derived in server/skills-core.ts.
export interface SkillStatus {
	kind: AgentKind;
	available: boolean;
	supported: boolean;
	installed: boolean;
	installedVersion: string | null;
	shippedVersion: string | null;
	upToDate: boolean;
}

// User-local, app-wide preferences (~/.deck/settings.json, never committed).
// `lastModels` is the global fallback for the new-session modal: a fresh project
// with no per-project pick defaults to the model you last used for that kind
// anywhere. This is where a private-infra default (e.g. a local LLM id) lives,
// off the public repo.
export interface DeckSettings {
	lastModels?: Partial<Record<AgentKind, ModelChoice>>;
}
