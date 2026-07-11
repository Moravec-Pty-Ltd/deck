// Pure logic for the persisted composer draft (no DOM / localStorage here so it
// stays unit-testable; the ClaudeView composer does the storage + UI wiring).
//
// There is a single global draft, deliberately not keyed by session: it carries
// across session switches (handy for referencing between sessions) and remembers
// which session it was started in (`originSessionId`) so the composer can warn
// before sending it into a different one.

export interface DraftAttachment {
	media_type: string;
	data: string; // base64 payload (no data: prefix)
	url: string; // data URL for display, reconstructed from media_type + data
}

export interface Draft {
	text: string;
	attachments: DraftAttachment[];
	// the session the draft was started in, or null when the draft is empty
	originSessionId: string | null;
}

// Attachments are base64 data URLs and can be large; localStorage is ~5MB and
// shared with other keys. Persist text always; persist attachments greedily up
// to this budget (base64 chars, summed) and drop the rest rather than throwing.
// Conservative so the UTF-16 storage cost stays well under quota.
export const ATTACHMENT_BUDGET = 1_500_000;

export function isEmptyDraft(draft: Pick<Draft, 'text' | 'attachments'>): boolean {
	return !draft.text.trim() && draft.attachments.length === 0;
}

function toUrl(media_type: string, data: string): string {
	return `data:${media_type};base64,${data}`;
}

// Greedily keep attachments whose cumulative base64 size fits the budget; drop
// the first that would overflow and everything after it (text is the priority).
export function clampAttachmentsToBudget(
	attachments: DraftAttachment[],
	budget = ATTACHMENT_BUDGET
): DraftAttachment[] {
	const kept: DraftAttachment[] = [];
	let used = 0;
	for (const a of attachments) {
		if (used + a.data.length > budget) break;
		kept.push(a);
		used += a.data.length;
	}
	return kept;
}

// Serialize for localStorage. Drops the reconstructable `url` and applies the
// attachment budget. An empty draft serializes to '' so callers can clear the key.
export function serializeDraft(draft: Draft, budget = ATTACHMENT_BUDGET): string {
	if (isEmptyDraft(draft)) return '';
	const attachments = clampAttachmentsToBudget(draft.attachments, budget).map((a) => ({
		media_type: a.media_type,
		data: a.data
	}));
	return JSON.stringify({ text: draft.text, attachments, originSessionId: draft.originSessionId });
}

// Parse a persisted string back to a Draft, rebuilding each attachment's `url`.
// Returns null for anything empty, missing, or malformed (nothing to restore).
export function parseDraft(raw: string | null | undefined): Draft | null {
	if (!raw) return null;
	let obj: unknown;
	try {
		obj = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!obj || typeof obj !== 'object') return null;
	const rec = obj as Record<string, unknown>;
	const text = typeof rec.text === 'string' ? rec.text : '';
	const originSessionId = typeof rec.originSessionId === 'string' ? rec.originSessionId : null;
	const attachments: DraftAttachment[] = Array.isArray(rec.attachments)
		? rec.attachments
				.filter(
					(a): a is { media_type: string; data: string } =>
						!!a &&
						typeof a === 'object' &&
						typeof (a as Record<string, unknown>).media_type === 'string' &&
						typeof (a as Record<string, unknown>).data === 'string'
				)
				.map((a) => ({ media_type: a.media_type, data: a.data, url: toUrl(a.media_type, a.data) }))
		: [];
	if (isEmptyDraft({ text, attachments })) return null;
	return { text, attachments, originSessionId };
}

// The origin session id after a draft edit: the session it was started in, held
// until the draft is emptied. `currentSessionId` is only adopted when the draft
// first becomes non-empty (origin still null).
export function nextOrigin(
	prevOrigin: string | null,
	isEmpty: boolean,
	currentSessionId: string
): string | null {
	if (isEmpty) return null;
	return prevOrigin ?? currentSessionId;
}

// Whether the draft was started in a different session than the one being viewed.
// Drives both the persistent "from:" chip and the confirm-on-send guard.
export function isCrossSession(
	originSessionId: string | null,
	currentSessionId: string
): boolean {
	return originSessionId !== null && originSessionId !== currentSessionId;
}
