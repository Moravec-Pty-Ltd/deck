import type { RequestHandler } from './$types';
import { zedCommandRoute } from '$lib/server/zed';

// See zed.ts.
export const GET: RequestHandler = zedCommandRoute;
