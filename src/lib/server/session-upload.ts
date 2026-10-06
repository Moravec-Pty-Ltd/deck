import { json, error } from '@sveltejs/kit';
import { objectBody, sessionOr404 } from './http';
import { persistUpload } from './uploads';
import { sendAgentMessage } from './send-agent-message';
import { sharedFileMessage, uploadTooLarge } from '$lib/upload-core';

// Share one or more files with a session. Shared verbatim by
// /api/sessions/[id]/upload (browser) and /api/agent/sessions/[id]/upload, the
// way session-title.ts is, so the two surfaces can't drift.
//
// The files are written under the data dir and the session is told where they
// are; the agent reads them from disk. That is the only form that works for
// arbitrary files — only images can be handed to a model inline, and those have
// their own path on the send endpoint.

interface Incoming {
	name: string;
	data: string;
}

// Base64 carries 3 bytes per 4 characters, so the encoded length gives the size
// without decoding: an oversized body is rejected before it becomes a buffer,
// and the rejection can still name how big it actually was.
function decodedBytes(data: string): number {
	return Math.floor((data.length * 3) / 4);
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function parseFile(raw: unknown): Incoming {
	const f = (raw ?? {}) as Record<string, unknown>;
	const data = str(f.data);
	if (!data) error(400, 'each file needs base64 `data`');
	const tooBig = uploadTooLarge(decodedBytes(data));
	if (tooBig) error(413, tooBig);
	return { name: str(f.name), data };
}

function parseFiles(v: unknown): Incoming[] {
	const list = Array.isArray(v) ? v : [];
	if (!list.length) error(400, 'files must be a non-empty array of { name, data }');
	if (list.length > 10) error(400, 'at most 10 files per share');
	return list.map(parseFile);
}

export async function uploadToSession(event: {
	params: Partial<Record<string, string>>;
	request: Request;
}): Promise<Response> {
	const session = await sessionOr404(event.params.id!);
	const body = await objectBody(event.request);
	const files = parseFiles(body.files);

	// Size was settled before anything was written (see parseFile), so nothing
	// oversized ever reaches the disk to be cleaned up afterwards.
	const stored = files.map((f) => persistUpload(session.id, f.name, f.data));
	await sendAgentMessage(session, { text: shareMessage(body.text, stored.map((s) => s.path)) });
	return json({ ok: true, files: stored });
}

// A share with no words of its own still has to say something, or the session
// gets a turn with an empty prompt and nothing to act on.
function shareMessage(text: unknown, paths: string[]): string {
	const said = typeof text === 'string' ? text.trim() : '';
	const files = sharedFileMessage(paths);
	return said ? `${said}\n\n${files}` : files;
}
