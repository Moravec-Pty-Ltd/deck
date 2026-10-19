import type { RequestHandler } from './$types';
import { pendingPairingsRoute } from '$lib/server/settings';

// Authed (not in PUBLIC_PATHS): the home page reads this on its poll to surface
// an approval prompt. Same handler as the agent API's GET /api/agent/pairing.
export const GET: RequestHandler = pendingPairingsRoute;
