import type { RequestHandler } from './$types';
import { sessionWorkflowRoute } from '$lib/server/session-workflow';

// Agent-namespace mirror of POST /api/sessions/[id]/workflow (issue #144): start
// or cancel a workflow run on an existing session, so an orchestrator can run a
// workflow after create and cancel one it started. Shared handler.
export const POST: RequestHandler = sessionWorkflowRoute;
