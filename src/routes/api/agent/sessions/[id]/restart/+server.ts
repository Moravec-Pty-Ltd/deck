import type { RequestHandler } from './$types';
import { restartSession } from '$lib/server/session-restart';

// See session-restart.ts.
export const POST: RequestHandler = restartSession;
