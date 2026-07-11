import { describe, expect, it } from 'vitest';
import {
	ATTACHMENT_BUDGET,
	clampAttachmentsToBudget,
	isCrossSession,
	isEmptyDraft,
	nextOrigin,
	parseDraft,
	serializeDraft,
	type Draft,
	type DraftAttachment
} from './composer-draft-core';

const att = (data: string, media_type = 'image/png'): DraftAttachment => ({
	media_type,
	data,
	url: `data:${media_type};base64,${data}`
});

const draft = (over: Partial<Draft> = {}): Draft => ({
	text: '',
	attachments: [],
	originSessionId: null,
	...over
});

describe('isEmptyDraft', () => {
	it('is empty for blank/whitespace text and no attachments', () => {
		expect(isEmptyDraft({ text: '', attachments: [] })).toBe(true);
		expect(isEmptyDraft({ text: '   \n\t', attachments: [] })).toBe(true);
	});
	it('is non-empty with text or attachments', () => {
		expect(isEmptyDraft({ text: 'hi', attachments: [] })).toBe(false);
		expect(isEmptyDraft({ text: '', attachments: [att('AA')] })).toBe(false);
	});
});

describe('clampAttachmentsToBudget', () => {
	it('keeps everything under budget', () => {
		const list = [att('a'.repeat(10)), att('b'.repeat(10))];
		expect(clampAttachmentsToBudget(list, 100)).toHaveLength(2);
	});
	it('drops the overflowing attachment and all after it', () => {
		const list = [att('a'.repeat(60)), att('b'.repeat(60)), att('c'.repeat(1))];
		// first fits (60), second would overflow 100, so drop it and the third
		expect(clampAttachmentsToBudget(list, 100).map((a) => a.data[0])).toEqual(['a']);
	});
	it('defaults to the shared budget', () => {
		const big = att('x'.repeat(ATTACHMENT_BUDGET + 1));
		expect(clampAttachmentsToBudget([big])).toHaveLength(0);
	});
});

describe('serializeDraft / parseDraft', () => {
	it('round-trips text, attachments and origin, rebuilding url', () => {
		const d = draft({ text: 'hello', attachments: [att('AAAA')], originSessionId: 's1' });
		const parsed = parseDraft(serializeDraft(d));
		expect(parsed).toEqual({
			text: 'hello',
			attachments: [att('AAAA')],
			originSessionId: 's1'
		});
	});
	it('does not persist the (reconstructable) url field', () => {
		const d = draft({ text: 'hi', attachments: [att('AAAA')] });
		expect(serializeDraft(d)).not.toContain('data:image/png');
	});
	it('serializes an empty draft to the empty string', () => {
		expect(serializeDraft(draft())).toBe('');
		expect(serializeDraft(draft({ text: '  ' }))).toBe('');
	});
	it('applies the attachment budget on serialize', () => {
		const d = draft({
			text: 'keep me',
			attachments: [att('a'.repeat(60)), att('b'.repeat(60))]
		});
		const parsed = parseDraft(serializeDraft(d, 100));
		expect(parsed?.text).toBe('keep me');
		expect(parsed?.attachments).toHaveLength(1);
	});
	it('returns null for empty, malformed, or contentless input', () => {
		expect(parseDraft(null)).toBeNull();
		expect(parseDraft('')).toBeNull();
		expect(parseDraft('not json')).toBeNull();
		expect(parseDraft('123')).toBeNull();
		expect(parseDraft(JSON.stringify({ text: '', attachments: [] }))).toBeNull();
	});
	it('ignores malformed attachment entries', () => {
		const raw = JSON.stringify({
			text: 't',
			attachments: [{ media_type: 'image/png' }, { data: 'x' }, 5, null],
			originSessionId: null
		});
		expect(parseDraft(raw)?.attachments).toEqual([]);
	});
});

describe('nextOrigin', () => {
	it('clears origin when the draft is empty', () => {
		expect(nextOrigin('s1', true, 's2')).toBeNull();
	});
	it('adopts the current session when the draft first becomes non-empty', () => {
		expect(nextOrigin(null, false, 's1')).toBe('s1');
	});
	it('keeps the original session once set, across switches', () => {
		expect(nextOrigin('s1', false, 's2')).toBe('s1');
	});
});

describe('isCrossSession', () => {
	it('is false with no origin or a matching session', () => {
		expect(isCrossSession(null, 's1')).toBe(false);
		expect(isCrossSession('s1', 's1')).toBe(false);
	});
	it('is true when origin differs from the viewed session', () => {
		expect(isCrossSession('s1', 's2')).toBe(true);
	});
});
