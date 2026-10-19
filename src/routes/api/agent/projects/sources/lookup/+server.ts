import type { RequestHandler } from './$types';
import { sourceLookupRoute } from '$lib/server/issue-source';

// Linear/ClickUp lookups while adding a source, same handler as the browser's
// POST /api/issues/meta; see issue-source.ts.
export const POST: RequestHandler = sourceLookupRoute;
