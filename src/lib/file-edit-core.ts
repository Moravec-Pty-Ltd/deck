import { MAX_TEXT_PREVIEW_BYTES, looksBinary, viewerFor } from './file-browser-core';

// Rules for saving an edited text file, kept free of node so they are testable
// and shared. The server hashes the bytes (files.ts); this only decides.

export const MAX_EDIT_BYTES = MAX_TEXT_PREVIEW_BYTES;

export type EditCheck = { ok: true } | { ok: false; status: 400 | 409 | 413; message: string };

export function checkEdit(input: {
	name: string;
	currentSize: number;
	currentHead: string;
	currentHash: string;
	newBytes: number;
	expected: string;
}): EditCheck {
	const viewer = viewerFor(input.name);
	if ((viewer !== 'text' && viewer !== 'markdown') || looksBinary(input.currentHead)) {
		return { ok: false, status: 400, message: 'only text files can be edited' };
	}
	if (input.currentSize > MAX_EDIT_BYTES || input.newBytes > MAX_EDIT_BYTES) {
		return { ok: false, status: 413, message: 'file too large to edit (limit 1 MB)' };
	}
	if (input.currentHash !== input.expected) {
		return { ok: false, status: 409, message: 'This file changed on disk since you opened it; reload it.' };
	}
	return { ok: true };
}
