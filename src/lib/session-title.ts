// What makes a valid session title, shared by the browser's rename field and
// the server routes behind it (see server/session-title.ts), so the input
// refuses the same things the API would and you find out before the round trip.

export const MAX_TITLE_LENGTH = 80;

export type ParsedTitle = { ok: true; title: string } | { ok: false; reason: string };

// A title lands in a list row, a browser tab, and a tmux status line, none of
// which survive a newline, so collapse every run of whitespace (control
// characters included) to one space. Empty is a rejection rather than a reset:
// every session has a title, and there is nothing to fall back to.
export function parseTitle(raw: unknown): ParsedTitle {
	if (typeof raw !== 'string') return { ok: false, reason: 'title must be a string' };
	const title = raw
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u001f\u007f]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (!title) return { ok: false, reason: 'title cannot be empty' };
	if (title.length > MAX_TITLE_LENGTH) {
		return { ok: false, reason: `title cannot be longer than ${MAX_TITLE_LENGTH} characters` };
	}
	return { ok: true, title };
}
