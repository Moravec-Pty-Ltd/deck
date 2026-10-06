// Sharing a file with a session: the naming and limits, kept node-free so the
// server and any client can agree on what will be accepted before sending it.
//
// Images already have their own path (base64 on the send endpoint, see
// server/images.ts). This is for everything else a share sheet can hand over —
// a PDF, a log, a screenshot recording — which the agent reads from disk rather
// than seeing inline.

// Big enough for a photo or a document, small enough that a base64 body stays
// sane over a LAN. Base64 inflates by about a third, so the request is ~33MB at
// the limit.
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// Keep the name the user recognises, minus anything that could escape the
// session's own directory or confuse a shell that later quotes it. Everything
// outside the allowed set becomes `-`, runs collapse, and the result is bounded
// so a long name can't push the path past what the filesystem takes.
export function safeUploadName(name: string): string {
	const base = name.split(/[/\\]/).pop() ?? '';
	const cleaned = base
		.replace(/[^a-zA-Z0-9._-]+/g, '-')
		.replace(/-{2,}/g, '-')
		.replace(/^[-.]+/, '')
		.slice(0, 80);
	return cleaned || 'file';
}

// Whether a decoded payload is within the limit, and why not when it isn't.
export function uploadTooLarge(bytes: number): string | null {
	if (bytes <= MAX_UPLOAD_BYTES) return null;
	return `file is ${mb(bytes)} MB; the limit is ${mb(MAX_UPLOAD_BYTES)} MB`;
}

function mb(bytes: number): string {
	return (bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '');
}

// What a session is told when a file arrives with no message of its own. Names
// the path, because reading it is the only thing the agent can usefully do.
export function sharedFileMessage(paths: string[]): string {
	if (paths.length === 1) return `I have shared a file with you: ${paths[0]}`;
	return [`I have shared ${paths.length} files with you:`, ...paths.map((p) => `- ${p}`)].join('\n');
}
