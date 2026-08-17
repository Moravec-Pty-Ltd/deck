import { describe, it, expect } from 'vitest';
import { conflictMessage, lockIsStale, parseLock, STALE_AFTER_MS, type InstanceLock } from './instance-lock-core';

const now = 1_000_000;
const lock: InstanceLock = { pid: 4242, port: 4818, startedAt: now - 60_000, heartbeat: now };
const live = { running: true, startedAt: lock.startedAt };

describe('lockIsStale', () => {
	it('holds a live deck process with a fresh heartbeat', () => {
		expect(lockIsStale(lock, now + 1000, live)).toBe(false);
	});

	it('treats a dead pid as stale', () => {
		expect(lockIsStale(lock, now, { running: false, startedAt: null })).toBe(true);
	});

	it('treats a stale heartbeat as stale even while the process runs', () => {
		expect(lockIsStale(lock, now + STALE_AFTER_MS, live)).toBe(false);
		expect(lockIsStale(lock, now + STALE_AFTER_MS + 1, live)).toBe(true);
	});

	it('treats a reused pid as stale', () => {
		expect(lockIsStale(lock, now, { running: true, startedAt: now - 5_000 })).toBe(true);
	});

	it('tolerates the second-resolution start time ps reports', () => {
		expect(lockIsStale(lock, now, { running: true, startedAt: lock.startedAt - 999 })).toBe(false);
	});

	it('keeps holding when the live start time cannot be read', () => {
		expect(lockIsStale(lock, now, { running: true, startedAt: null })).toBe(false);
	});

	it('treats a missing lock as stale', () => {
		expect(lockIsStale(null, now, { running: false, startedAt: null })).toBe(true);
	});
});

describe('parseLock', () => {
	it('accepts a well-formed record', () => {
		expect(parseLock({ ...lock })).toEqual(lock);
	});

	it('rejects junk, a bad pid, or missing timestamps', () => {
		expect(parseLock(null)).toBeNull();
		expect(parseLock('nope')).toBeNull();
		expect(parseLock({ ...lock, pid: 0 })).toBeNull();
		expect(parseLock({ ...lock, pid: '4242' })).toBeNull();
		expect(parseLock({ ...lock, startedAt: undefined })).toBeNull();
		expect(parseLock({ ...lock, heartbeat: undefined })).toBeNull();
	});
});

describe('conflictMessage', () => {
	it('names the holder and points at DECK_DATA', () => {
		const msg = conflictMessage(lock, '/home/me/.deck');
		expect(msg).toContain('pid 4242');
		expect(msg).toContain('port 4818');
		expect(msg).toContain('/home/me/.deck');
		expect(msg).toContain('DECK_DATA');
	});
});
