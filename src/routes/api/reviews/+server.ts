import type { RequestHandler } from './$types';
import { reviewsRoute } from '$lib/server/reviews-route';

// The morabot review snapshot, same handler as GET /api/agent/reviews; see reviews-route.ts.
export const GET: RequestHandler = reviewsRoute;
