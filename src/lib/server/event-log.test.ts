import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pinEnv } from './test-env';
import type { SeqEvent } from './event-log-core';

// event-log reads its file path from config at import time; pin a throwaway
// DECK_DATA first. Each test file gets its own module graph under vitest
// isolation, so the global counter here doesn't collide with agent-feed.test.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-eventlog-'));
const restoreEnv = pinEnv({ DECK_DATA: tmpDir });

const { appendEventLog, readCursor, currentLogSeq } = await import('./event-log');

afterAll(() => {
	restoreEnv();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// appendEventLog assigns the seq on commit and stamps the passed object with it.
async function append(sessionId: string, type: string): Promise<number> {
	const event = { seq: 0, sessionId, type, at: 0 } as SeqEvent;
	await appendEventLog(event);
	return event.seq;
}

describe('event-log IO', () => {
	it('assigns contiguous committed seqs and advances the on-disk cursor', async () => {
		const a = await append('c_1', 'status');
		const b = await append('c_1', 'status');
		expect(a).toBeGreaterThan(0);
		expect(b).toBe(a + 1);
		expect(currentLogSeq()).toBe(b);
	});

	it('readCursor returns only events after the cursor, plus the current seq', async () => {
		const from = currentLogSeq();
		await append('c_2', 'turn-finished');
		const last = await append('c_2', 'pr');
		const read = readCursor(from);
		expect(read.gap).toBe(false);
		expect(read.seq).toBe(last);
		expect(read.events.every((e) => e.seq > from)).toBe(true);
		expect(read.events.map((e) => e.seq)).toContain(last);
	});

	it('a caught-up cursor returns no events and no gap', async () => {
		const head = currentLogSeq();
		const read = readCursor(head);
		expect(read.gap).toBe(false);
		expect(read.events).toEqual([]);
		expect(read.seq).toBe(head);
	});

	it('persists every event as one parseable line whose seq matches the cursor', async () => {
		const seq = await append('c_3', 'session-deleted');
		const raw = fs.readFileSync(path.join(tmpDir, 'events.jsonl'), 'utf8').trim().split('\n');
		const lastLine = JSON.parse(raw[raw.length - 1]);
		expect(lastLine.seq).toBe(seq);
		expect(lastLine.sessionId).toBe('c_3');
	});
});
