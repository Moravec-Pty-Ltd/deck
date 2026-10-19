import type { RequestHandler } from './$types';
import { sourceLookupRoute } from '$lib/server/issue-source';

// Linear/ClickUp lookups for the add-source form, same handler as the agent
// API's POST /api/agent/projects/sources/lookup; see issue-source.ts.
export const POST: RequestHandler = sourceLookupRoute;
