import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { agentInfo } from '$lib/server/agent-capabilities';

export const GET: RequestHandler = () => json(agentInfo());
