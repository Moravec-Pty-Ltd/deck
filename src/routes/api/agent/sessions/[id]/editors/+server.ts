import type { RequestHandler } from './$types';
import { editorsRoute } from '$lib/server/editors';

// See editors.ts.
export const GET: RequestHandler = editorsRoute;
