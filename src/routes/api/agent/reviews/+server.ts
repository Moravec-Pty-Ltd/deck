import type { RequestHandler } from './$types';
import { reviewsRoute } from '$lib/server/reviews-route';

// Same handler as the browser's GET /api/reviews; see reviews-route.ts.
export const GET: RequestHandler = reviewsRoute;
