import { describe, expect, it } from 'vitest';
import { eventTime, formatMessageTime } from './message-time';

const TZ = 'Europe/Prague';
// 6 Nov 2026, 10:00 in Prague (CET, UTC+1).
const NOW = Date.UTC(2026, 10, 6, 9, 0);

describe('formatMessageTime', () => {
	it('shows only the time for a message from today, on a 24-hour clock', () => {
		expect(formatMessageTime(Date.UTC(2026, 10, 6, 8, 5), NOW, TZ)).toBe('09:05');
		expect(formatMessageTime(Date.UTC(2026, 10, 5, 23, 30), NOW, TZ)).toBe('00:30');
	});

	it('adds the date as DD-MM-YYYY for anything before today, even a minute before midnight', () => {
		expect(formatMessageTime(Date.UTC(2026, 10, 5, 22, 59), NOW, TZ)).toBe('05-11-2026 23:59');
		expect(formatMessageTime(Date.UTC(2025, 11, 31, 13, 7), NOW, TZ)).toBe('31-12-2025 14:07');
	});

	it("judges today in the viewer's time zone, not UTC", () => {
		// 23:30 UTC on the 5th is already the 6th in Prague.
		expect(formatMessageTime(Date.UTC(2026, 10, 5, 23, 30), NOW, TZ)).toBe('00:30');
		expect(formatMessageTime(Date.UTC(2026, 10, 5, 23, 30), NOW, 'UTC')).toBe('05-11-2026 23:30');
	});
});

describe('eventTime', () => {
	it("reads deck's ms stamp and Claude's ISO timestamp", () => {
		expect(eventTime({ type: 'deck.user', ts: 1791368631973 })).toBe(1791368631973);
		expect(eventTime({ type: 'assistant', timestamp: '2026-10-10T20:48:09.002Z' })).toBe(Date.UTC(2026, 9, 10, 20, 48, 9, 2));
	});

	it('gives null when the event carries no usable time', () => {
		expect(eventTime({ type: 'assistant' })).toBeNull();
		expect(eventTime({ type: 'assistant', timestamp: 'not a date' })).toBeNull();
	});
});
