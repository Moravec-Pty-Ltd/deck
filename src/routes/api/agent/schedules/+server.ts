import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { objectBody } from '$lib/server/http';
import { listSchedules, saveSchedule } from '$lib/server/schedule-store';
import { digest, scheduleFromRequest } from '$lib/server/schedule-api';

// Schedules (issue #235): every schedule, and creating one. Newest first, the
// same order the runs list uses.
export const GET: RequestHandler = async () => {
	return json([...listSchedules()].sort((a, b) => b.createdAt - a.createdAt).map(digest));
};

export const POST: RequestHandler = async ({ request }) => {
	const schedule = scheduleFromRequest(await objectBody(request));
	saveSchedule(schedule);
	return json(digest(schedule), { status: 201 });
};
