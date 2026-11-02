// A watch's decisions (issue #277), kept node-free so they unit-test without a
// store, a shell or an agent: validating a create request, the per-session cap,
// what is due, what history to keep, and the message a fired watch wakes its
// session with. Firing is watcher.ts.
import { z } from 'zod';
import type { Watch, WatchResult } from '$lib/watches';

// How far ahead a watch may fire. The default keeps a forgotten watch from
// waking a session days later; DECK_WATCH_MAX_DELAY (see maxDelayFromEnv)
// raises or lowers it for an install that waits on slower things.
export const MAX_DELAY_MS = 24 * 60 * 60 * 1000;
// The setting is clamped here so a typo cannot park a watch for a year.
export const MAX_DELAY_CEILING_MS = 30 * 24 * 60 * 60 * 1000;
// A looping agent must not be able to pile watches up.
export const ACTIVE_CAP = 5;
export const CHECK_TIMEOUT_MS = 60_000;
export const OUTPUT_CAP = 4000;
export const HISTORY_MS = 24 * 60 * 60 * 1000;
const COMMAND_CAP = 1000;

export class WatchError extends Error {}

const requestSchema = z
	.object({
		title: z.string().trim().min(1, 'a title is required').max(200),
		prompt: z.string().trim().min(1, 'a prompt is required').max(20_000),
		in: z.string().trim().optional(),
		at: z.union([z.string().trim(), z.number()]).optional(),
		command: z.string().trim().max(COMMAND_CAP).optional()
	})
	.refine((r) => (r.in !== undefined) !== (r.at !== undefined), {
		message: 'give exactly one of `in` (a delay like "10m") or `at` (a time)'
	});

export interface WatchInput {
	title: string;
	prompt: string;
	command?: string;
	dueAt: number;
}

const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };

// "30s", "10m", "2h", "1h30m", "3d": each unit at most once, largest first.
export function parseDelay(text: string): number | null {
	const m = text.trim().toLowerCase().match(/^(?:(\d+)d)?\s*(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?$/);
	if (!m || !(m[1] || m[2] || m[3] || m[4])) return null;
	return [m[1], m[2], m[3], m[4]].reduce((ms, n, i) => ms + Number(n ?? 0) * UNIT_MS['dhms'[i]], 0);
}

// DECK_WATCH_MAX_DELAY ("72h", "7d"): unset or unreadable keeps the default,
// anything above the ceiling is clamped to it.
export function maxDelayFromEnv(value: string | undefined): number {
	const ms = value?.trim() ? parseDelay(value) : null;
	if (!ms) return MAX_DELAY_MS;
	return Math.min(ms, MAX_DELAY_CEILING_MS);
}

// "24 hours", "7 days", "36 hours": how the limit reads in errors and docs.
export function describeMaxDelay(ms: number): string {
	const hours = Math.round(ms / 3_600_000);
	if (hours >= 48 && hours % 24 === 0) return `${hours / 24} days`;
	return hours === 1 ? '1 hour' : `${hours} hours`;
}

function parseAt(at: string | number): number | null {
	const ms = typeof at === 'number' ? at : /^\d+$/.test(at) ? Number(at) : Date.parse(at);
	return Number.isFinite(ms) ? ms : null;
}

export function parseWatchRequest(raw: unknown, now: number, maxDelayMs = MAX_DELAY_MS): WatchInput {
	const parsed = requestSchema.safeParse(raw);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		throw new WatchError(issue?.path.length ? `${issue.path.join('.')}: ${issue.message}` : (issue?.message ?? 'invalid watch'));
	}
	const r = parsed.data;
	let dueAt: number;
	if (r.in !== undefined) {
		const delay = parseDelay(r.in);
		if (delay === null) throw new WatchError('in: use a delay like "30s", "10m", "2h", "1h30m" or "2d"');
		dueAt = now + delay;
	} else {
		const at = parseAt(r.at!);
		if (at === null) throw new WatchError('at: use an ISO time or epoch milliseconds');
		dueAt = at;
	}
	if (dueAt <= now) throw new WatchError('the watch must fire in the future');
	if (dueAt - now > maxDelayMs) throw new WatchError(`a watch can fire at most ${describeMaxDelay(maxDelayMs)} from now`);
	return { title: r.title, prompt: r.prompt, command: r.command || undefined, dueAt };
}

// This session's active watches, newest first: what the digest and `watches` list.
export function activeFor(watches: Watch[], sessionId: string): Watch[] {
	return watches
		.filter((w) => w.sessionId === sessionId && w.state === 'active')
		.sort((a, b) => b.createdAt - a.createdAt);
}

export function capReached(watches: Watch[], sessionId: string): boolean {
	return activeFor(watches, sessionId).length >= ACTIVE_CAP;
}

export function isDue(watch: Watch, now: number): boolean {
	return watch.state === 'active' && watch.dueAt <= now;
}

// Run now: due at once, so the next poll fires it exactly as the timer would.
// An ended watch, or one already due, comes back as it is.
export function bringForward(watch: Watch, now: number): Watch {
	return watch.state === 'active' && watch.dueAt > now ? { ...watch, dueAt: now } : watch;
}

// Ended watches stay a day as history, then go.
export function prune(watches: Watch[], now: number): Watch[] {
	return watches.filter((w) => w.state === 'active' || (w.endedAt ?? 0) > now - HISTORY_MS);
}

export function tail(output: string, cap = OUTPUT_CAP): string {
	return output.length > cap ? output.slice(-cap) : output;
}

// A fence longer than any backtick run in the output, so the output cannot close it.
function fenced(text: string): string {
	const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
	const fence = '`'.repeat(longest + 1);
	return `${fence}\n${text.trimEnd()}\n${fence}`;
}

function checkLine(command: string, result: WatchResult): string {
	if (result.timedOut) return `Check: \`${command}\` timed out after ${CHECK_TIMEOUT_MS / 1000}s and was stopped`;
	if (result.exitCode === null) return `Check: \`${command}\` did not run`;
	return `Check: \`${command}\` exited ${result.exitCode}`;
}

export function wakeMessage(watch: Pick<Watch, 'title' | 'prompt' | 'command' | 'result'>): string {
	const parts = [`## Watch: ${watch.title}`, watch.prompt];
	if (watch.command && watch.result) {
		parts.push(checkLine(watch.command, watch.result));
		if (watch.result.output.trim()) parts.push(fenced(watch.result.output));
	}
	return parts.join('\n\n');
}

export const CHECK_NOT_ALLOWED =
	'check commands only run in sessions that skip permission prompts; set the watch without a command';

// A check runs shell outside the agent's own permission checks, so only a session
// already allowed to run anything may give one.
export function checkAllowed(session: { permissionMode?: string }): boolean {
	return session.permissionMode === 'bypassPermissions';
}
