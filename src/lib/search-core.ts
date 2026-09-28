// Pure logic for transcript search: which lines are worth parsing, what text
// an event contributes, and how a hit is snipped for display. Node-free so it
// unit-tests; the file streaming lives in server/search.ts.

export interface SearchHit {
	sessionId: string;
	title: string;
	// Absolute index of the event on the session's transcript, for deep links.
	index: number;
	role: 'user' | 'assistant';
	snippet: string;
	// The event's own timestamp when it carries one, else the session's activity.
	at: number;
}

const SNIPPET_RADIUS = 70;

// A raw JSONL line can only hold the query if the query's text appears in it
// somewhere; checking that before JSON.parse skips most of a transcript.
export function lineMayMatch(rawLine: string, needle: string): boolean {
	return rawLine.toLowerCase().includes(needle.toLowerCase());
}

// The human text an event carries: what you typed, or what the agent said.
// Tool calls and results are skipped: their output is where a query would
// otherwise match a thousand times over.
export function searchableText(event: Record<string, unknown>): { role: 'user' | 'assistant'; text: string } | null {
	if (event.type === 'deck.user' && typeof event.text === 'string') return { role: 'user', text: event.text };
	if (event.type !== 'assistant') return null;
	const content = (event.message as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return null;
	const text = content
		.filter((b): b is { type: string; text: string } => !!b && b.type === 'text' && typeof b.text === 'string')
		.map((b) => b.text)
		.join('\n');
	return text.trim() ? { role: 'assistant', text } : null;
}

// A window of text around the first case-insensitive match, on one line,
// with ellipses where it was cut. Null when the text holds no match.
export function snippetAround(text: string, needle: string, radius = SNIPPET_RADIUS): string | null {
	const flat = text.replace(/\s+/g, ' ');
	const at = flat.toLowerCase().indexOf(needle.toLowerCase());
	if (at < 0) return null;
	const start = Math.max(0, at - radius);
	const end = Math.min(flat.length, at + needle.length + radius);
	return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`;
}

// Queries shorter than this match too much to be useful.
export const MIN_QUERY_CHARS = 2;

export function normaliseQuery(raw: string | null | undefined): string {
	return (raw ?? '').trim().replace(/\s+/g, ' ');
}

// ---- Matching sessions by name ----
// Searching a session's name is the common case: you know which session you
// want and you want to get to it. Transcript hits still show, under the name
// matches, for when you only remember something that was said.

export interface NameMatch {
	id: string;
	title: string;
	// Lower sorts first: an exact title, then a prefix, then anything else.
	rank: number;
}

// Every session whose title contains all the words typed, best match first.
// Word-wise rather than substring, so "auth token" finds "Auth: token refresh"
// and the order of what you type does not matter.
export function matchSessionNames(
	query: string,
	sessions: { id: string; title?: string | null }[]
): NameMatch[] {
	const needle = normaliseQuery(query).toLowerCase();
	if (needle.length < MIN_QUERY_CHARS) return [];
	const words = needle.split(' ').filter(Boolean);

	const matches: NameMatch[] = [];
	for (const session of sessions) {
		const title = (session.title ?? '').trim();
		if (!title) continue;
		const lower = title.toLowerCase();
		if (!words.every((w) => lower.includes(w))) continue;
		matches.push({
			id: session.id,
			title,
			rank: lower === needle ? 0 : lower.startsWith(needle) ? 1 : 2
		});
	}
	// Stable within a rank, so the caller's order (recency) is kept.
	return matches.sort((a, b) => a.rank - b.rank);
}
