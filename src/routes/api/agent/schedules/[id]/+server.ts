import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { objectBody } from '$lib/server/http';
import { getSchedule, removeSchedule, saveSchedule } from '$lib/server/schedule-store';
import { applyPatch, digest } from '$lib/server/schedule-api';
import type { Schedule } from '$lib/schedules';

function scheduleOr404(id: string): Schedule {
	const schedule = getSchedule(id);
	if (!schedule) error(404, 'schedule not found');
	return schedule;
}

export const GET: RequestHandler = async ({ params }) => {
	return json(digest(scheduleOr404(params.id!)));
};

// A patch, not a replace: a client sends only what it changed, so an old tab
// cannot wipe a field it has never heard of.
export const PATCH: RequestHandler = async ({ params, request }) => {
	const patched = applyPatch(scheduleOr404(params.id!), await objectBody(request));
	saveSchedule(patched);
	return json(digest(patched));
};

// Deleting a schedule leaves the sessions it started alone. They hold the work
// it did, and the schedule is only the thing that asked for it.
export const DELETE: RequestHandler = async ({ params }) => {
	if (!removeSchedule(params.id!)) error(404, 'schedule not found');
	return json({ ok: true });
};
