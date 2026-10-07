// Durable state for schedules (issue #235): every schedule in
// ~/.deck/schedules.json, read once and written whole on each change. Single
// user, a handful of schedules, the same bargain runs.json makes.
import { customAlphabet } from 'nanoid';
import { readJson, writeJson } from './config';
import { nextDue } from './schedule-core';
import type { Schedule } from '$lib/schedules';

const FILE = 'schedules.json';

const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 8);

export function newScheduleId(): string {
	return `sch_${nanoid()}`;
}

interface SchedulesFile {
	schedules: Schedule[];
}

// Survives HMR in dev so the tick and the routes share one copy.
const g = globalThis as { __deckSchedules?: SchedulesFile };

// A stored schedule with the fields a hand-edited or older file can be missing.
// `nextRunAt` is filled in here rather than at firing time: a schedule with no
// due time would never come round, and a file someone edited by hand to change a
// cron expression should pick the new one up on the next read.
function normalize(raw: Partial<Schedule>, now: number): Schedule {
	const schedule: Schedule = {
		id: raw.id || newScheduleId(),
		title: raw.title || 'Scheduled prompt',
		cron: raw.cron || '',
		prompt: raw.prompt || '',
		enabled: raw.enabled !== false,
		sessionId: raw.sessionId,
		cwd: raw.cwd,
		agent: raw.agent,
		createdAt: raw.createdAt || now,
		nextRunAt: raw.nextRunAt,
		lastRunAt: raw.lastRunAt,
		lastOutcome: raw.lastOutcome,
		lastNote: raw.lastNote,
		lastSessionId: raw.lastSessionId,
		runs: raw.runs ?? 0
	};
	schedule.nextRunAt ??= nextDue(schedule, now);
	return schedule;
}

function state(): SchedulesFile {
	if (!g.__deckSchedules) {
		const raw = readJson<Partial<SchedulesFile>>(FILE, {});
		const now = Date.now();
		const schedules = Array.isArray(raw.schedules) ? raw.schedules.map((s) => normalize(s, now)) : [];
		g.__deckSchedules = { schedules };
	}
	return g.__deckSchedules;
}

function persist(): void {
	writeJson(FILE, state());
}

export function listSchedules(): Schedule[] {
	return state().schedules;
}

export function getSchedule(id: string): Schedule | undefined {
	return state().schedules.find((s) => s.id === id);
}

// Insert or replace a schedule and write the file.
export function saveSchedule(schedule: Schedule): void {
	const s = state();
	const i = s.schedules.findIndex((x) => x.id === schedule.id);
	if (i === -1) s.schedules.push(schedule);
	else s.schedules[i] = schedule;
	persist();
}

export function removeSchedule(id: string): boolean {
	const s = state();
	const before = s.schedules.length;
	s.schedules = s.schedules.filter((x) => x.id !== id);
	if (s.schedules.length === before) return false;
	persist();
	return true;
}
