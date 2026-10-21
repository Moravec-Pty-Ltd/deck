import type { RequestHandler } from './$types';
import { sourceLookupRoute } from '$lib/server/issue-source';

// Linear/ClickUp lookups while adding a source; see issue-source.ts.
export const POST: RequestHandler = sourceLookupRoute;
