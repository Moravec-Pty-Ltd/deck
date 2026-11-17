import type { RequestHandler } from './$types';
import { installAgentRoute } from '$lib/server/remote-route';

export const POST: RequestHandler = installAgentRoute;
