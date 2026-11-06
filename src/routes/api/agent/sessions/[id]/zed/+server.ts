import type { RequestHandler } from './$types';
import { zedCommandRoute } from '$lib/server/editors';

// See editors.ts.
export const GET: RequestHandler = zedCommandRoute;
