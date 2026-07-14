import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { AgentKind } from '$lib/types';
import { agentAvailability } from '$lib/server/agents/available';
import { listAgentModels } from '$lib/server/agents/models';

// kind + model discovery (issue #144): which agent CLIs are installed on this
// machine (so an orchestrator picks an available kind rather than 400-ing at
// spawn) and the models each enumerates. `model` is otherwise free-text, so an
// empty `models` list means "pass any id the CLI accepts".
const KINDS: AgentKind[] = ['claude', 'pi', 'codex', 'opencode'];

export const GET: RequestHandler = async () => {
	const available = await agentAvailability();
	const kinds = await Promise.all(
		KINDS.map(async (kind) => ({
			kind,
			available: available[kind],
			models: await listAgentModels(kind)
		}))
	);
	return json(kinds);
};
