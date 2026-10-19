import type { RequestHandler } from './$types';
import { terminalInputRoute, terminalSnapshotRoute } from '$lib/server/terminal';

// GET is the browser's /snapshot handler; POST types into the pane the same way
// the browser's /send does for a shell. See terminal.ts.
export const GET: RequestHandler = terminalSnapshotRoute;
export const POST: RequestHandler = terminalInputRoute;
