import type { RequestHandler } from './$types';
import { changeSessionAgent } from '$lib/server/session-agent';

export const POST: RequestHandler = changeSessionAgent;
