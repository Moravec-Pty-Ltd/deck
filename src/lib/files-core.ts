// Local files a message mentions: finding their paths in the text and deciding
// how to show them (an image gets a preview, anything else a download chip).
// Node-free so the web client and the server share one reading of a message;
// the server alone decides whether a path is actually served (see
// server/files.ts).

export interface FileInfo {
	// The path as it appeared in the text, so the client can match it back.
	path: string;
	name: string;
	size: number;
	mime: string;
	image: boolean;
}

// Absolute (`/a/b.png`), home (`~/b.png`), file URLs and explicit relative
// paths (`./b.png`, `../b.png`) with an extension. Bare relative mentions like
// `src/lib/foo.ts` are left alone: coding replies are full of them and they are
// references, not files being handed over. A path stops at whitespace, quotes,
// brackets and the punctuation that ends a sentence, so `/tmp/a.png.` and
// `(/tmp/a.png)` both yield `/tmp/a.png`.
const PATH_RE =
	/(?<![\w/:.@~-])(?:file:\/\/)?((?:~|\.{1,2})?\/(?:[^\s"'`<>|*?()[\]{},;:]+\/)*[^\s"'`<>|*?()[\]{},;:/]+\.[A-Za-z0-9]{1,8})(?![\w/-]|\.[\w/])/g;

export const MAX_PATHS_PER_MESSAGE = 20;

export function findFilePaths(text: string): string[] {
	const found: string[] = [];
	for (const match of text.matchAll(PATH_RE)) {
		const p = match[1];
		if (!found.includes(p)) found.push(p);
		if (found.length >= MAX_PATHS_PER_MESSAGE) break;
	}
	return found;
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'heic', 'heif']);

export function extensionOf(p: string): string {
	const name = basename(p);
	const dot = name.lastIndexOf('.');
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function basename(p: string): string {
	return p.slice(p.lastIndexOf('/') + 1);
}

export function isImagePath(p: string): boolean {
	return IMAGE_EXTENSIONS.has(extensionOf(p));
}

const MIME: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	avif: 'image/avif',
	bmp: 'image/bmp',
	svg: 'image/svg+xml',
	heic: 'image/heic',
	heif: 'image/heif',
	pdf: 'application/pdf',
	json: 'application/json',
	txt: 'text/plain',
	md: 'text/markdown',
	csv: 'text/csv',
	html: 'text/html',
	log: 'text/plain',
	zip: 'application/zip',
	mp4: 'video/mp4',
	m4v: 'video/mp4',
	mov: 'video/quicktime',
	webm: 'video/webm',
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	m4a: 'audio/mp4'
};

export function mimeFor(p: string): string {
	return MIME[extensionOf(p)] ?? 'application/octet-stream';
}

export function isVideoMime(mime: string): boolean {
	return mime.startsWith('video/');
}

// The single byte range a `Range: bytes=...` header asks for, inclusive, or
// 'unsatisfiable' (a 416). null serves the whole file: no header, a malformed
// one, or several ranges (which only a multipart reply could answer).
export function byteRange(header: string | null, size: number): { start: number; end: number } | 'unsatisfiable' | null {
	const m = header?.trim().match(/^bytes=(\d*)-(\d*)$/);
	if (!m || (!m[1] && !m[2])) return null;
	let start: number;
	let end: number;
	if (!m[1]) {
		start = Math.max(size - Number(m[2]), 0);
		end = size - 1;
	} else {
		start = Number(m[1]);
		end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
	}
	if (start >= size || start > end) return 'unsatisfiable';
	return { start, end };
}

// Types a browser would run scripts from when shown as a page.
export function scriptable(mime: string): boolean {
	return mime === 'image/svg+xml' || mime === 'text/html' || mime.endsWith('xml');
}

export function formatBytes(size: number): string {
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
	return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
