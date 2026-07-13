import type { RequestHandler } from './$types';
import { sessionWorkflowRoute } from '$lib/server/session-workflow';

// Start or cancel a workflow run on an existing session (issue #111). The handler
// is shared verbatim with the agent-namespace mirror
// POST /api/agent/sessions/[id]/workflow (issue #144).
export const POST: RequestHandler = sessionWorkflowRoute;
