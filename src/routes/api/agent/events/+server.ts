import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listSessions } from '$lib/server/sessions';
import { sessionDigest } from '$lib/server/agent-digest';
import { agentFeed } from '$lib/server/agent-feed';
import { currentLogSeq, readCursor, type CursorRead } from '$lib/server/event-log';
import { parseSince, parseWait } from '$lib/server/event-log-core';

// The global monitor cursor (issue #143). Replaces the old SSE stream with a
// resumable read over the durable event log (~/.deck/events.jsonl):
//
//   (no ?since)      → bootstrap: { snapshot: <all-session digest>, seq }
//   ?since=<seq>     → { events: <events after seq>, seq }
//   too-old ?since   → { gap: true, snapshot, seq } so the consumer re-snapshots
//   ?since=<seq>&wait=1 → long-poll: hold up to ~25s for the next event
//
// `seq` is the single cursor: a consumer tracks the last seq it processed and
// resumes from it, restart-safe, no persistent socket. Local consumers tail the
// file directly; this endpoint is the tailnet/remote surface. Same header auth as
// the rest of /api/*.

const WAIT_MS = 25_000;

function snapshot() {
	return listSessions().then((sessions) => sessions.map((s) => sessionDigest(s)));
}

async function respond(read: CursorRead): Promise<Response> {
	if (read.gap) return json({ gap: true, snapshot: await snapshot(), seq: read.seq });
	return json({ events: read.events, seq: read.seq });
}

// Resolve on the next agent event or after the timeout, whichever comes first.
// Exposes cleanup so a caller that returns early (already had events) detaches the
// listener instead of leaking it.
function waitForEvent(): { woke: Promise<void>; cleanup: () => void } {
	let cleanup = () => {};
	const woke = new Promise<void>((resolve) => {
		const done = () => {
			cleanup();
			resolve();
		};
		const timer = setTimeout(done, WAIT_MS);
		agentFeed.on('event', done);
		cleanup = () => {
			clearTimeout(timer);
			agentFeed.off('event', done);
		};
	});
	return { woke, cleanup };
}

// Bootstrap: snapshot + cursor floor. Capture the floor before the snapshot so
// nothing slips between them — an event landing during the snapshot read gets a
// seq above the floor and is redelivered on the next poll (applied idempotently),
// never skipped.
async function bootstrap(): Promise<Response> {
	const seq = currentLogSeq();
	return json({ snapshot: await snapshot(), seq });
}

// Long-poll: subscribe before the first read so an event landing between them
// still wakes us; clean up whichever way we return.
async function longPoll(since: number): Promise<Response> {
	const { woke, cleanup } = waitForEvent();
	try {
		const first = readCursor(since);
		if (first.gap || first.events.length) return await respond(first);
		await woke;
		return await respond(readCursor(since));
	} finally {
		cleanup();
	}
}

export const GET: RequestHandler = async ({ url }) => {
	const sinceRaw = url.searchParams.get('since');
	if (sinceRaw === null) return bootstrap();

	const since = parseSince(sinceRaw);
	if (since === null) error(400, 'since must be a non-negative integer');

	if (parseWait(url.searchParams.get('wait'))) return longPoll(since);
	return respond(readCursor(since));
};
