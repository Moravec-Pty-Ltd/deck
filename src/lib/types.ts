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
	// set when deck created this session inside a git worktree
	worktree?: { repo: string; branch: string; createdBranch: boolean };
	// set when the session was started from an issue picked in the new-session modal
	issue?: SessionIssue;
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
	template?: string;
	lastBase?: string;
	// Issue sources are per-project and additive. API keys never live here; they
	// sit in ~/.deck/secrets.json keyed by source id (see server/store.ts).
	sources?: IssueSource[];
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
