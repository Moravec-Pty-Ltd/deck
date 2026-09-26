import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { skillCatalogue } from '$lib/server/skills-catalogue';

// The skills installed on this machine, so a client can tell a session to run
// one (as `/name arguments`) and can say what one does without guessing.
export const GET: RequestHandler = async () => json({ skills: skillCatalogue() });
