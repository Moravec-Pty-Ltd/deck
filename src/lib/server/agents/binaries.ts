import type { AgentKind } from '$lib/types';

// The CLI binary each agent kind spawns. The availability probe
// (GET /api/agents/available) and every session spawn site read this one map, so
// a rename can't drift the "is it installed?" check away from what actually runs.
// claude isn't an AgentDriver but still launches a binary, so it's included here;
// shell (tmux) launches no agent binary and is intentionally absent.
export const AGENT_BINARIES: Record<AgentKind, string> = {
	claude: 'claude',
	pi: 'pi',
	codex: 'codex',
	opencode: 'opencode'
};
