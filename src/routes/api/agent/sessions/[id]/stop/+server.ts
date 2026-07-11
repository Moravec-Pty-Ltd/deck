import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { agentSessionOr404 } from '$lib/server/http';
import { agentInterrupt } from '$lib/server/agents/dispatch';
import { noteInterrupt } from '$lib/server/workflows';

// Interrupt the in-flight turn. A workflow agent step must read the interrupt
// as failure, not a cleanly finished turn (see workflows.ts turnOutcome).
export const POST: RequestHandler = async ({ params }) => {
	const session = await agentSessionOr404(params.id);
	noteInterrupt(session.id);
	agentInterrupt(session.id);
	return json({ ok: true });
};
