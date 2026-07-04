import type { DeckSession } from '$lib/types';

// Drivers parse a per-turn agent CLI's JSONL output into deck's normalised event
// shape (the same one Claude emits), so one chat view renders every agent.
export type DeckEvent = Record<string, unknown>;

export interface TurnContext {
	// Persist to the transcript and broadcast (shows on reload and live).
	append: (event: DeckEvent) => void;
	// Broadcast only (live streaming deltas, never persisted).
	emit: (event: DeckEvent) => void;
	// Record the agent's resume handle (codex thread id, pi session id).
	setAgentSessionId: (agentId: string) => void;
}

export interface AgentTurn {
	cmd: string;
	args: string[];
	// Text to pipe to stdin; when unset the prompt is carried in args.
	stdin?: string;
}

export interface AgentDriver {
	kind: 'pi' | 'codex' | 'opencode';
	// Build the command for one turn; resumeId is the stored agentSessionId.
	buildTurn(session: DeckSession, message: string, resumeId: string | undefined): AgentTurn;
	// Map one parsed stdout JSON line into normalised deck events via ctx.
	handleLine(line: Record<string, unknown>, ctx: TurnContext): void;
}
