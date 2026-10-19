import fs from 'node:fs';
import { error, json } from '@sveltejs/kit';
import readline from 'node:readline';
import { isAgentKind, type DeckSession } from '$lib/types';
import { MIN_QUERY_CHARS, lineMayMatch, normaliseQuery, searchableText, snippetAround, type SearchHit } from '$lib/search-core';
import { listStoredSessions } from './store';
import { transcriptPath } from './transcript';

// Search what was said across every agent session's transcript: user prompts
// and assistant text, newest sessions first. Transcripts are streamed line by
// line with a cheap substring prefilter before any JSON parsing, and bounded
// by hits per session, total hits, and wall time, so a query over months of
// history returns promptly rather than exactly.

export const SEARCH_LIMIT_MAX = 100;
const PER_SESSION_MAX = 5;
const TIME_BUDGET_MS = 3_000;

// The hit one transcript line yields for the query, or null. The raw
// substring check runs before any parsing, so most lines cost a scan only.
function hitFrom(session: DeckSession, raw: string, index: number, needle: string): SearchHit | null {
	if (!lineMayMatch(raw, needle)) return null;
	let event: Record<string, unknown>;
	try {
		event = JSON.parse(raw);
	} catch {
		return null;
	}
	const found = searchableText(event);
	const snippet = found && snippetAround(found.text, needle);
	if (!found || !snippet) return null;
	const at = typeof event.ts === 'number' ? event.ts : session.lastActiveAt;
	return { sessionId: session.id, title: session.title, index, role: found.role, snippet, at };
}

async function searchSession(session: DeckSession, needle: string, deadline: number): Promise<SearchHit[]> {
	const file = transcriptPath(session.id);
	if (!fs.existsSync(file)) return [];
	const hits: SearchHit[] = [];
	const stream = fs.createReadStream(file, { encoding: 'utf8' });
	const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
	let index = -1;
	try {
		for await (const raw of lines) {
			index += 1;
			if (hits.length >= PER_SESSION_MAX || Date.now() > deadline) break;
			const hit = hitFrom(session, raw, index, needle);
			if (hit) hits.push(hit);
		}
	} finally {
		lines.close();
		stream.destroy();
	}
	return hits;
}

export async function searchTranscripts(needle: string, limit: number): Promise<{ hits: SearchHit[]; truncated: boolean }> {
	const deadline = Date.now() + TIME_BUDGET_MS;
	const sessions = listStoredSessions()
		.filter((s) => isAgentKind(s.kind))
		.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
	const hits: SearchHit[] = [];
	let truncated = false;
	for (const session of sessions) {
		if (hits.length >= limit || Date.now() > deadline) {
			truncated = true;
			break;
		}
		hits.push(...(await searchSession(session, needle, deadline)));
	}
	return { hits: hits.slice(0, limit), truncated: truncated || hits.length > limit };
}

// GET handler shared by /api/search and /api/agent/search: full-text search over
// what was said in every agent session. `q` is a plain case-insensitive
// substring; hits carry the session and the event index so a client can open the
// session at that point (/s/{id}?at={index}).
export async function searchRoute({ url }: { url: URL }): Promise<Response> {
	const q = normaliseQuery(url.searchParams.get('q'));
	if (q.length < MIN_QUERY_CHARS) error(400, `query must be at least ${MIN_QUERY_CHARS} characters`);
	const limit = Math.min(SEARCH_LIMIT_MAX, Math.max(1, Number(url.searchParams.get('limit')) || 30));
	return json({ query: q, ...(await searchTranscripts(q, limit)) });
}
