import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { systemStats } from '$lib/server/system-stats';

// The machine's CPU, memory and disk use, for the header meter.
export const GET: RequestHandler = () => json(systemStats());
