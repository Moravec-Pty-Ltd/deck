export function relativeTime(ts: number): string {
	const diff = Date.now() - ts;
	const minutes = Math.floor(diff / 60000);
	if (minutes < 1) return 'now';
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 14) return `${days}d`;
	return new Date(ts).toLocaleDateString();
}

// A time of day as a short local reading, formatted rather than localised: a
// schedule means a reading on the wall clock, and the same string should come
// out on the phone and in the browser whatever each has its locale set to.
export function clockTime(ts: number): string {
	const d = new Date(ts);
	const hours = d.getHours();
	const hour = hours % 12 === 0 ? 12 : hours % 12;
	return `${hour}:${String(d.getMinutes()).padStart(2, '0')}${hours < 12 ? 'am' : 'pm'}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Which local calendar day an instant falls on, as a day number. Built from the
// date fields so a clock change, which makes a day 23 or 25 hours long, cannot
// put two readings on the same day or one day on two numbers.
function localDay(ts: number): number {
	const d = new Date(ts);
	return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
}

// When something is due, as a wall-clock time plus enough of the day to place
// it. Counted in calendar days rather than in 24-hour blocks, so 1am after a
// late night reads as tomorrow and not as today.
export function whenDue(ts: number, now = Date.now()): string {
	const time = clockTime(ts);
	const days = localDay(ts) - localDay(now);
	if (days <= 0) return time;
	if (days === 1) return `${time} tomorrow`;
	if (days < 7) return `${time} ${WEEKDAYS[new Date(ts).getDay()]}`;
	return `${time} ${new Date(ts).toLocaleDateString()}`;
}

// Collapse a home prefix to ~ for display. Runs in the browser, so it can't
// read the real homedir; instead it matches the common roots: macOS
// (/Users/<name>), Linux (/home/<name>), root (/root), and Windows
// (C:\Users\<name>). The two branches are mutually exclusive by separator.
export function shortPath(p: string): string {
	return p
		.replace(/^(\/Users\/[^/]+|\/home\/[^/]+|\/root)(?=\/|$)/, '~')
		.replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, '~');
}

import type { Project } from '$lib/types';

// Map a session cwd to a group: worktrees fold back under their repo, then we
// match the longest registered project path; otherwise the repo/cwd itself.
export function deriveGroup(
	cwd: string,
	projects: Project[]
): { key: string; label: string } {
	const wt = cwd.indexOf('-worktrees/');
	const base = wt >= 0 ? cwd.slice(0, wt) : cwd;

	let best: Project | undefined;
	for (const p of projects) {
		const matches = base === p.path || base.startsWith(p.path + '/') || cwd.startsWith(p.path + '/');
		if (matches && (!best || p.path.length > best.path.length)) best = p;
	}
	if (best) return { key: best.path, label: best.name };
	return { key: base, label: shortPath(base) };
}
