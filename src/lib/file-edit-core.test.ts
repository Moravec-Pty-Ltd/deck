import { describe, it, expect } from 'vitest';
import { MAX_EDIT_BYTES, checkEdit } from './file-edit-core';

const base = { name: '.env', currentSize: 10, currentHead: 'A=1\n', currentHash: 'abc', newBytes: 12, expected: 'abc' };

describe('checkEdit', () => {
	it('accepts a text file whose hash matches', () => {
		expect(checkEdit(base)).toEqual({ ok: true });
	});
	it('conflicts when the hash differs', () => {
		expect(checkEdit({ ...base, expected: 'old' })).toMatchObject({ ok: false, status: 409 });
	});
	it('refuses binary names and content', () => {
		expect(checkEdit({ ...base, name: 'a.png' })).toMatchObject({ ok: false, status: 400 });
		expect(checkEdit({ ...base, currentHead: 'a\0b' })).toMatchObject({ ok: false, status: 400 });
	});
	it('refuses oversized current or new content', () => {
		expect(checkEdit({ ...base, currentSize: MAX_EDIT_BYTES + 1 })).toMatchObject({ ok: false, status: 413 });
		expect(checkEdit({ ...base, newBytes: MAX_EDIT_BYTES + 1 })).toMatchObject({ ok: false, status: 413 });
		expect(checkEdit({ ...base, newBytes: MAX_EDIT_BYTES })).toEqual({ ok: true });
	});
});
