import type { RequestHandler } from './$types';
import { completeDirsRoute } from '$lib/server/project-record';

// Same handler as the agent API's /api/agent/fs/complete; see project-record.ts.
export const GET: RequestHandler = completeDirsRoute;
