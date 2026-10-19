import type { ImageInput } from './claude';
import { isInlineImage } from '$lib/upload-core';

export function parseImages(raw: unknown): ImageInput[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.filter(
			(i): i is ImageInput =>
				!!i &&
				typeof i.media_type === 'string' &&
				isInlineImage(i.media_type) &&
				typeof i.data === 'string' &&
				i.data.length < 12_000_000
		)
		.slice(0, 8);
}

