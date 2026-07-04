import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { agentAvailability } from '$lib/server/agents/available';

// Which agent CLIs are installed on this machine, so the new-session picker can
// hide harnesses that would only fail at spawn. Picker visibility only: the
// session API still accepts any valid kind.
export const GET: RequestHandler = async () => json(await agentAvailability());
