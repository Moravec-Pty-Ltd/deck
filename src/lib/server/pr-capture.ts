import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { DeckSession, SessionPR } from '$lib/types';
import { isReviewSession, prLinks } from '$lib/pr';
import { projectForPath } from './confine';
import { parseOriginRepo } from './git';
import { getStoredSession, listProjects, updateSession } from './store';
import { publishAgentEvent } from './agent-feed';
import { createTtlCache } from './ttl-cache';

const exec = promisify(execFile);
const remotesCache = createTtlCache<string[]>(5 * 60_000);

const remotesOf = (dir: string) => exec('git', ['-c', 'core.fsmonitor=false', '-C', dir, 'remote', '-v'], { timeout: 5000 });

function parseRemotes(stdout: string): string[] {
	return stdout.split('\n').map((line) => parseOriginRepo(line.split(/\s+/)[1] ?? '') ?? '');
}

// The checkouts directly inside a folder that is not one itself.
function childCheckouts(dir: string): string[] {
	const names = fs.readdirSync(dir).slice(0, 200);
	return names.map((n) => path.join(dir, n)).filter((d) => fs.existsSync(path.join(d, '.git'))).slice(0, 30);
}

// Throws when git fails for any other reason than there being no repository, so
// a failure is never read as "no repo known".
async function remoteRepos(cwd: string): Promise<string[]> {
	try {
		return parseRemotes((await remotesOf(cwd)).stdout);
	} catch (e) {
		if (!/not a git repository/i.test(String((e as { stderr?: unknown }).stderr))) throw e;
	}
	const inside = await Promise.all(childCheckouts(cwd).map(remotesOf));
	return inside.flatMap((r) => parseRemotes(r.stdout));
}

// The repos a session's PR may be in, lower-cased: its checkout's git remotes (a
// fork's PR is in its upstream), those of the checkouts inside a plain folder, and
// its project's GitHub sources. A remote session's checkout is on its host, so only
// the sources count. Empty when none is known.
async function ownRepos(session: DeckSession): Promise<Set<string>> {
	const project = projectForPath(session.cwd);
	const sources = listProjects().find((p) => p.path === project)?.sources ?? [];
	const listed = sources.flatMap((s) => (s.type === 'github' ? [`${s.owner}/${s.repo}`] : []));
	const remotes = session.remote ? [] : await remotesCache.getOrFetch(session.cwd, false, () => remoteRepos(session.cwd));
	return new Set([...remotes, ...listed].filter(Boolean).map((r) => r.toLowerCase()));
}

// The PR that text a session's agent produced binds it to: the last link to one
// in its own repos. A session started on a PR keeps that one.
export async function prToCapture(session: DeckSession, text: string): Promise<SessionPR | null> {
	if (session.prSeeded || isReviewSession(session)) return null;
	const links = prLinks(text);
	if (!links.length) return null;
	const own = await ownRepos(session);
	const match = links.findLast((l) => !own.size || own.has(l.repo.toLowerCase()));
	return match ? { ...match, seenAt: Date.now() } : null;
}

// One capture at a time per session, so an earlier event's lookup can't land after
// a later one's.
const queues = new Map<string, Promise<void>>();

// Bind a session to the PR in `text`, in the background. `unlessBound` leaves one
// captured meanwhile alone (a backfill reads older text).
export function capturePr(id: string, text: string, unlessBound = false): Promise<void> {
	const run = (queues.get(id) ?? Promise.resolve())
		.then(() => bindPr(id, text, unlessBound))
		.catch((e) => console.error(`[deck] PR capture failed for ${id}:`, e))
		.finally(() => {
			if (queues.get(id) === run) queues.delete(id);
		});
	queues.set(id, run);
	return run;
}

// Whether a PR found for `before` still applies to the session as it is `now`:
// not deleted, not dismissed during the lookup, and not bound already.
function stillApplies(before: DeckSession, now: DeckSession | undefined, url: string, unlessBound: boolean): boolean {
	if (!now) return false;
	if (!now.pr) return !before.pr;
	return !unlessBound && now.pr.url !== url;
}

async function bindPr(id: string, text: string, unlessBound: boolean): Promise<void> {
	const session = getStoredSession(id);
	const pr = session && (await prToCapture(session, text));
	if (!pr || !stillApplies(session, getStoredSession(id), pr.url, unlessBound)) return;
	updateSession(id, { pr });
	publishAgentEvent(id, 'pr', { pr });
}
