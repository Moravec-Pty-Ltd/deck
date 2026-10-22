// The combined list after the last chat bubble: a session's active watches and
// its running subagents, newest first, capped to three until expanded.
import { formatDuration, type AgentState } from '$lib/subagents-core';
import type { Watch } from '$lib/watches';

const ACTIVITY_CAP = 3;

export type ActivityEntry =
	| { kind: 'watch'; key: string; at: number; watch: Watch }
	| { kind: 'agent'; key: string; at: number; agent: AgentState };

// `agentStart` gives when an agent began (the transcript carries no timestamp).
export function activityEntries(
	watches: Watch[],
	agents: AgentState[],
	agentStart: (a: AgentState) => number
): ActivityEntry[] {
	return [
		...watches.map((watch): ActivityEntry => ({ kind: 'watch', key: `w:${watch.id}`, at: watch.createdAt, watch })),
		...agents.map((agent): ActivityEntry => ({ kind: 'agent', key: `a:${agent.taskId}`, at: agentStart(agent), agent }))
	].sort((a, b) => b.at - a.at);
}

export function visibleEntries(entries: ActivityEntry[], expanded: boolean): { shown: ActivityEntry[]; more: number } {
	if (expanded || entries.length <= ACTIVITY_CAP) return { shown: entries, more: 0 };
	return { shown: entries.slice(0, ACTIVITY_CAP), more: entries.length - ACTIVITY_CAP };
}

// "4m 12s", "1h 3m", "due" once the time has come.
export function formatCountdown(ms: number): string {
	return ms <= 0 ? 'due' : formatDuration(Math.ceil(ms / 1000) * 1000);
}
