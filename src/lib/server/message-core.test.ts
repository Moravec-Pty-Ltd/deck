import { expect, it } from 'vitest';
import { imageKindError, parseImages } from './message-core';

it('filters unsupported and oversized images and caps the attachment count', () => {
	const image = { media_type: 'image/png', data: 'aGVsbG8=' };
	expect(parseImages([null, { ...image, media_type: 'text/html' }, { ...image, data: 'x'.repeat(12_000_000) }, image])).toEqual([image]);
	expect(parseImages(Array(12).fill(image))).toHaveLength(8);
	expect(parseImages({})).toEqual([]);
});

it('refuses images for any kind but claude', () => {
	const images = parseImages([{ media_type: 'image/png', data: 'aGVsbG8=' }]);
	expect(imageKindError('claude', images)).toBeNull();
	expect(imageKindError('codex', [])).toBeNull();
	expect(imageKindError('codex', images)).toBe('image attachments require a claude session');
});
