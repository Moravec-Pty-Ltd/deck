// A watch (issue #277): a timer an agent sets through deck's MCP server, with an
// optional quick check command run once when it falls due. It fires once, waking
// the session that set it, and is done.

export type WatchState = 'active' | 'fired' | 'cancelled';

export interface WatchResult {
	// null when the check was killed or could not start
	exitCode: number | null;
	// the tail of stdout and stderr, capped
	output: string;
	timedOut?: boolean;
}

export interface Watch {
	id: string;
	sessionId: string;
	title: string;
	prompt: string;
	command?: string;
	createdAt: number;
	dueAt: number;
	state: WatchState;
	// when it fired or was cancelled
	endedAt?: number;
	// set when a watch with a command fired
	result?: WatchResult;
}
