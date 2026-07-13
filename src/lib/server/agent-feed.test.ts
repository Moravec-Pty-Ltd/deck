import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pinEnv } from './test-env';

// publishAgentEvent now assigns a seq and appends to the durable log under
// ~/.deck (event-log.ts reads the dir from config at import), so pin a throwaway
// DECK_DATA before importing anything that pulls it in.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-feed-'));
const restoreEnv = pinEnv({ DECK_DATA: tmpDir });

const { agentFeed, publishAgentEvent } = await import('./agent-feed');
const { currentLogSeq, readCursor } = await import('./event-log');

afterAll(() => {
	restoreEnv();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// The emit now fires after the durable write settles, so wait for it rather than
// asserting synchronously.
function nextEvent(): Promise<Record<string, unknown>> {
	return new Promise((resolve) => agentFeed.once('event', (e) => resolve(e)));
}

describe('publishAgentEvent', () => {
	it('assigns a monotonic seq and emits { seq, sessionId, type, at } after the write', async () => {
		const got = nextEvent();
		publishAgentEvent('c_1', 'status', { status: 'idle' });
		const event = await got;
		expect(event).toMatchObject({ sessionId: 'c_1', type: 'status', status: 'idle' });
		expect(event.seq).toBeTypeOf('number');
		expect(event.at).toBeTypeOf('number');

		const got2 = nextEvent();
		publishAgentEvent('c_1', 'status', { status: 'running' });
		const event2 = await got2;
		expect(event2.seq).toBe((event.seq as number) + 1);
	});

	it('durably appends the event so a cursor read after the write returns it', async () => {
		const got = nextEvent();
		publishAgentEvent('c_2', 'turn-finished', { subtype: 'success' });
		const event = await got;
		const read = readCursor((event.seq as number) - 1);
		expect(read.gap).toBe(false);
		expect(read.events.some((e) => e.seq === event.seq && e.sessionId === 'c_2')).toBe(true);
		expect(currentLogSeq()).toBeGreaterThanOrEqual(event.seq as number);
	});

	it('a throwing subscriber does not escape into the producer', async () => {
		const boom = () => {
			throw new Error('subscriber bug');
		};
		agentFeed.on('event', boom);
		try {
			expect(() => publishAgentEvent('c_1', 'session-deleted')).not.toThrow();
			// let the deferred emit fire and be swallowed
			await new Promise((r) => setTimeout(r, 20));
		} finally {
			agentFeed.off('event', boom);
		}
	});
});
