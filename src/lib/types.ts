export type SessionKind = 'claude' | 'shell';
export type SessionStatus = 'running' | 'idle' | 'error' | 'dead';

export interface DeckSession {
	id: string;
	kind: SessionKind;
	title: string;
	cwd: string;
	createdAt: number;
	lastActiveAt: number;
	status: SessionStatus;
	// claude
	claudeSessionId?: string;
	model?: string;
	permissionMode?: 'acceptEdits' | 'bypassPermissions' | 'default' | 'plan';
	// shell
	tmuxName?: string;
	managed?: boolean;
	attached?: boolean;
	// set when deck created this session inside a git worktree
	worktree?: { repo: string; branch: string; createdBranch: boolean };
}

export interface Project {
	name: string;
	path: string;
	template?: string;
	lastBase?: string;
}

// Prefilled values for the new-session modal when launched from a shortcut
// (sidebar quick-add, "shell in this worktree", etc.).
export interface NewSessionPreset {
	kind?: SessionKind;
	projectPath?: string;
	cwd?: string;
	title?: string;
}
