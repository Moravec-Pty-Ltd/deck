import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { skillBody } from '$lib/server/skills-catalogue';

// One skill's SKILL.md, truncated. 404 when no skills directory holds it.
export const GET: RequestHandler = async ({ params }) => {
	const body = skillBody(params.name);
	if (body === null) error(404, 'skill not found');
	return json({ name: params.name, body });
};
