// Query parsing for a transcript back-scroll slice, shared by the browser's
// /api/sessions/[id]/transcript and the agent API's /history. A missing or
// unparseable `before` means "from the end", so a client with no cursor yet
// gets the latest page; `limit` falls back to a page and is held to RANGE_MAX
// so a crafted value can't make one request read the whole transcript.
export const RANGE_DEFAULT = 200;
export const RANGE_MAX = 1000;

export interface TranscriptRange {
	before: number;
	limit: number;
}

function wholeNumber(raw: string | null): number | undefined {
	if (raw === null || raw.trim() === '') return undefined;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

export function parseTranscriptRange(params: URLSearchParams): TranscriptRange {
	const before = wholeNumber(params.get('before')) ?? Number.MAX_SAFE_INTEGER;
	const limit = wholeNumber(params.get('limit')) || RANGE_DEFAULT;
	return { before, limit: Math.min(limit, RANGE_MAX) };
}
