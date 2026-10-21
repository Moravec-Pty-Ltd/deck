import type { RequestHandler } from './$types';
import { serverActionRoute } from '$lib/server/devservers-route';

// Act on one dev server, same handler as the agent API's twin; see devservers-route.ts.
export const POST: RequestHandler = serverActionRoute;
