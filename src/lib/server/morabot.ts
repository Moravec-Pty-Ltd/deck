// Server orchestration for the morabot integration (issue #188): confine + read
// the status.json morabot writes, cache the derived snapshot for the sidebar, and
// push one notification per new verdict that lands on a session's captured PR. The
// pure parsing / matching / state logic lives in morabot-core.ts. deck is
// read-only on this file and tolerates it being absent, stale, or unparseable.
import fs from 'node:fs';
import path from 'node:path';
import type { DeckSession } from '$lib/types';
import { morabotStatusPath, readJson, writeJson } from './config';
import { resolveWithinProjects } from './confine';
import { notify } from './push';
import {
	deriveReviewsPayload,
	decisionLabel,
	matchSessionForReview,
	parseMorabotStatus,
	reviewNotifyKey,
	selectNewReviews,
	type MorabotStatus,
	type RecentReview,
	type ReviewsPayload
} from '$lib/morabot-core';

const LEDGER_FILE = 'morabot.json';

// Durable dedupe ledger. `initialized` guards the first run: whatever verdicts are
// already in the file when deck first sees it are baselined silently, so a fresh
// start (or a restart onto a populated `recent`) never fires a burst of historical
// notifications.
interface Ledger {
	initialized: boolean;
	notified: Record<string, number>;
}

// Validate the configured path resolves inside a registered project (the morabot
// repo is registered on this machine). realpath needs an existing path, and the
// status file may not have been written yet, so validate the nearest existing
// ancestor directory. Returns the original path to read, or null to disable.
function validateStatusPath(p: string): string | null {
	let probe = p;
	while (!fs.existsSync(probe)) {
		const parent = path.dirname(probe);
		if (parent === probe) return null;
		probe = parent;
	}
	return resolveWithinProjects(probe) ? p : null;
}

const statusPath = morabotStatusPath === null ? null : validateStatusPath(morabotStatusPath);

if (morabotStatusPath !== null && statusPath === null) {
	console.warn(
		`[deck] DECK_MORABOT_STATUS=${morabotStatusPath} does not resolve inside a registered project; morabot integration disabled.`
	);
}

const UNCONFIGURED: ReviewsPayload = { status: 'unconfigured', inFlight: null, recent: [] };

let lastMtimeMs: number | null = null;
let lastParsed: MorabotStatus | null = null;
let snapshot: ReviewsPayload =
	statusPath === null ? UNCONFIGURED : { status: 'offline', inFlight: null, recent: [] };
let ledger: Ledger | null = null;

function getLedger(): Ledger {
	if (!ledger) ledger = readJson<Ledger>(LEDGER_FILE, { initialized: false, notified: {} });
	return ledger;
}

// Record a review as seen and, if it lands on a session's captured PR, push one
// notification deep-linking to that session.
function markAndNotify(l: Ledger, r: RecentReview, sessions: DeckSession[], now: number): void {
	l.notified[reviewNotifyKey(r.reviewId)] = now;
	const session = matchSessionForReview(r, sessions);
	if (!session) return;
	notify({
		title: `${decisionLabel(r.decision)} · ${r.repo}#${r.pr}`,
		body: session.title,
		tag: `morabot:${r.reviewId}`,
		url: `/s/${session.id}`
	});
}

// One push per new verdict matching a session's captured PR. Every fresh review id
// is recorded (matched or not) so it's considered exactly once, across restarts.
// On the first run whatever is already in `recent` is baselined silently (no push).
function notifyNewVerdicts(recent: RecentReview[], sessions: DeckSession[], now: number): void {
	const l = getLedger();
	const fresh = selectNewReviews(recent, l.notified);
	if (fresh.length === 0) return;
	const announce = l.initialized;
	for (const r of fresh) {
		if (announce) markAndNotify(l, r, sessions, now);
		else l.notified[reviewNotifyKey(r.reviewId)] = now;
	}
	l.initialized = true;
	writeJson(LEDGER_FILE, l);
}

// The recent list, treating an absent/unparseable snapshot as empty.
function recentOf(s: MorabotStatus | null): RecentReview[] {
	return s ? s.recent : [];
}

// Re-parse only when the file's mtime changed (cheap when idle); returns false when
// the file is absent. Updates the cached parse.
function refreshParsed(path: string): boolean {
	let mtimeMs: number;
	try {
		mtimeMs = fs.statSync(path).mtimeMs;
	} catch {
		lastMtimeMs = null;
		lastParsed = null;
		return false;
	}
	if (mtimeMs !== lastMtimeMs) {
		lastMtimeMs = mtimeMs;
		try {
			lastParsed = parseMorabotStatus(JSON.parse(fs.readFileSync(path, 'utf8')));
		} catch {
			lastParsed = null;
		}
	}
	return true;
}

// Poll tick: refresh the cached parse, then re-derive the snapshot every tick so a
// file that stopped updating transitions to `offline` on its own. Self-guarding.
export function pollMorabot(sessions: DeckSession[]): void {
	if (statusPath === null) return;
	const now = Date.now();
	if (!refreshParsed(statusPath)) {
		snapshot = { status: 'offline', inFlight: null, recent: [] };
		return;
	}
	snapshot = deriveReviewsPayload(lastParsed, now);
	notifyNewVerdicts(recentOf(lastParsed), sessions, now);
}

// The cached client payload for GET /api/reviews.
export function cachedReviews(): ReviewsPayload {
	return snapshot;
}
