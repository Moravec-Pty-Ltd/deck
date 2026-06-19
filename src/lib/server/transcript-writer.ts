import fs from 'node:fs';

// Transcript appends used to call fs.appendFileSync on the streaming hot path,
// blocking the single event loop (which also serves every SSE stream and poll)
// once per persisted event. Appends are async now, but two writes to the same
// file must not interleave or reorder, so each file gets a promise chain: every
// append waits for the previous append to that file before it runs. Kept on
// globalThis (like the event bus) so HMR in dev can't drop an in-flight chain.
const g = globalThis as { __deckTranscriptTails?: Map<string, Promise<unknown>> };
const tails = (g.__deckTranscriptTails ??= new Map<string, Promise<unknown>>());

// Queue an async append, preserving call order per file. Returns the write
// promise so callers can observe failures; the live view never awaits it (it
// streams off the in-memory bus, with disk only feeding reload and back-scroll).
export function appendLine(file: string, line: string): Promise<void> {
	// Chain off the error-swallowed tail so one failed write can't wedge the
	// file's queue; the new write still surfaces its own error to the caller.
	const prev = tails.get(file) ?? Promise.resolve();
	const write = prev.then(() => fs.promises.appendFile(file, line));
	const tail = write.catch(() => {});
	tails.set(file, tail);
	// Drop the entry once the queue drains so the map doesn't grow per session.
	// The `=== tail` guard is load-bearing: a newer append may have replaced the
	// tail before this settles, and that successor chain must not be deleted.
	tail.then(() => {
		if (tails.get(file) === tail) tails.delete(file);
	});
	return write;
}
