import { MAX_PATHS_PER_MESSAGE, type FileInfo } from './files-core';

// Asks deck which files a message's mentions point at. Every bubble asks on
// its own, so answers are remembered per session and the asks made in one
// tick (a transcript rendering dozens of bubbles at once) go up as a few
// batched requests rather than one per bubble.

type Settle = (file: FileInfo | null) => void;

const known = new Map<string, Promise<FileInfo | null>>();
const queued = new Map<string, Map<string, Settle>>();

export function fileUrl(sessionId: string, path: string, download = false): string {
	const url = `/api/sessions/${encodeURIComponent(sessionId)}/files?path=${encodeURIComponent(path)}`;
	return download ? `${url}&download=1` : url;
}

export function statFile(sessionId: string, path: string): Promise<FileInfo | null> {
	const key = `${sessionId}\0${path}`;
	const hit = known.get(key);
	if (hit) return hit;
	const promise = new Promise<FileInfo | null>((resolve) => enqueue(sessionId, path, resolve));
	known.set(key, promise);
	return promise;
}

/// The servable files among `paths`, in the order given.
export async function statFiles(sessionId: string, paths: string[]): Promise<FileInfo[]> {
	const files = await Promise.all(paths.map((p) => statFile(sessionId, p)));
	return files.filter((f): f is FileInfo => f !== null);
}

function enqueue(sessionId: string, path: string, settle: Settle) {
	let batch = queued.get(sessionId);
	if (!batch) {
		batch = new Map();
		queued.set(sessionId, batch);
		queueMicrotask(() => void flush(sessionId));
	}
	batch.set(path, settle);
}

async function flush(sessionId: string) {
	const batch = queued.get(sessionId);
	queued.delete(sessionId);
	if (!batch) return;
	const paths = [...batch.keys()];
	for (let i = 0; i < paths.length; i += MAX_PATHS_PER_MESSAGE) {
		const chunk = paths.slice(i, i + MAX_PATHS_PER_MESSAGE);
		const found = await ask(sessionId, chunk);
		for (const path of chunk) {
			// A failed ask is not an answer: forget it so a later render asks again.
			if (!found) known.delete(`${sessionId}\0${path}`);
			batch.get(path)?.(found?.get(path) ?? null);
		}
	}
}

async function ask(sessionId: string, paths: string[]): Promise<Map<string, FileInfo> | null> {
	try {
		const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/files`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ paths })
		});
		if (!res.ok) return null;
		const body = (await res.json()) as { files: FileInfo[] };
		return new Map(body.files.map((f) => [f.path, f]));
	} catch {
		return null;
	}
}
