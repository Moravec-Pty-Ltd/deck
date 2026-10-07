import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ScheduleBusy, runScheduleNow } from '$lib/server/scheduler';
import { digest } from '$lib/server/schedule-api';
import type { Schedule } from '$lib/schedules';

// 409 rather than 400: nothing about the request was wrong, it is just not the
// moment. Kept apart from the handler so the 404 below cannot be caught here.
async function attempt(id: string): Promise<Schedule | undefined> {
	try {
		return await runScheduleNow(id);
	} catch (e) {
		if (e instanceof ScheduleBusy) error(409, e.message);
		throw e;
	}
}

// Run a schedule now, whatever its due time says, and whether or not it is
// switched off: pressing the button is the decision. The due time still moves on
// to the next real window, so a manual run does not shift the schedule.
export const POST: RequestHandler = async ({ params }) => {
	const schedule = await attempt(params.id!);
	if (!schedule) error(404, 'schedule not found');
	return json(digest(schedule));
};
