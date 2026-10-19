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


// The per-turn runners of the other kinds accept text only, and an attachment
// must never be dropped silently.
export function imageKindError(kind: string, images: ImageInput[]): string | null {
	return images.length && kind !== 'claude' ? 'image attachments require a claude session' : null;
}
