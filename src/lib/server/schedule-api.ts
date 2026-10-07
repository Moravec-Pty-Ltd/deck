// The HTTP boundary for schedules (issue #235): turn an untyped body into a
// stored schedule, and a stored schedule into the digest both clients read.
// Shared by the routes so the web app and the iOS app see the same shapes.
import { error } from '@sveltejs/kit';
import fs from 'node:fs';
import type { Schedule, ScheduleDigest } from '$lib/schedules';
import { expandTilde } from './fsutil';
import { getStoredSession, listProjects } from './store';
import { ScheduleError, nextDue, parseScheduleRequest, parseSchedulePatch, type ScheduleInput } from './schedule-core';
import { newScheduleId } from './schedule-store';

// A schedule with the names behind its ids filled in. The server resolves them
// because it has both the session store and the project list to hand, and
// neither client should have to join three lists to render a row.
export function digest(schedule: Schedule): ScheduleDigest {
	const session = schedule.sessionId ? getStoredSession(schedule.sessionId) : undefined;
	const project = schedule.cwd ? listProjects().find((p) => p.path === schedule.cwd) : undefined;
	return {
		...schedule,
		// Absent for a session that has gone, which is what the UI shows as the
		// reason a schedule stopped.
		sessionTitle: session?.title,
		projectName: project?.name
	};
}

// The target directory, expanded and checked. Done here rather than at firing
// time: a path typo should fail in the form, not silently at 9am tomorrow.
function resolveCwd(cwd: string): string {
	const resolved = expandTilde(cwd);
	if (!fs.existsSync(resolved)) error(400, 'that directory does not exist');
	return resolved;
}

// A schedule problem becomes a 400 carrying its one-line message; anything else
// is a bug here and keeps its own status.
function parse(raw: unknown, patchOf?: Schedule): ScheduleInput {
	try {
		return patchOf ? parseSchedulePatch(raw, patchOf) : parseScheduleRequest(raw);
	} catch (e) {
		if (e instanceof ScheduleError) error(400, e.message);
		throw e;
	}
}

// A session target has to name a session that exists and can take a prompt.
// Checked at the boundary so the form says so, rather than the schedule failing
// at its first window and switching itself off.
function assertTargetUsable(input: ScheduleInput): void {
	if (!input.sessionId) return;
	const session = getStoredSession(input.sessionId);
	if (!session) error(400, 'that session does not exist');
	if (session.kind === 'shell') error(400, 'a terminal session cannot take a prompt');
}

function validate(raw: unknown, patchOf?: Schedule): ScheduleInput {
	const input = parse(raw, patchOf);
	assertTargetUsable(input);
	return input.cwd ? { ...input, cwd: resolveCwd(input.cwd) } : input;
}

// A new schedule from a request body, already due at its first window.
export function scheduleFromRequest(raw: unknown): Schedule {
	const input = validate(raw);
	const now = Date.now();
	return { ...input, id: newScheduleId(), createdAt: now, runs: 0, nextRunAt: nextDue(input, now) };
}

// A stored schedule with a patch applied. The due time is recomputed whenever
// the expression changes, so an edit takes effect at the next window rather
// than at the one the old expression had already booked.
export function applyPatch(existing: Schedule, raw: unknown): Schedule {
	const input = validate(raw, existing);
	const changedCron = input.cron !== existing.cron;
	// Switching a schedule back on re-books it too: the due time it was carrying
	// is from before it was switched off, and is very likely in the past.
	const switchedOn = input.enabled && !existing.enabled;
	return {
		...existing,
		...input,
		nextRunAt: changedCron || switchedOn ? nextDue(input, Date.now()) : existing.nextRunAt
	};
}
