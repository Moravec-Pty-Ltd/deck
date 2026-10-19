import { describe, expect, it } from 'vitest';
import { parseSnapshotQuery, parseTerminalInput, SNAPSHOT_LINES_MAX, TEXT_MAX_BYTES } from './terminal-core';

describe('parseTerminalInput', () => {
	it.each([
		[{ key: 'Enter' }, { key: 'Enter' }],
		[{ key: 'C-c', text: 'ignored' }, { key: 'C-c' }],
		[{ text: 'ls -la' }, { text: 'ls -la', submit: true }],
		[{ text: 'partial', submit: false }, { text: 'partial', submit: false }],
		[{ text: '' }, { text: '', submit: true }],
		[{ text: 'x'.repeat(TEXT_MAX_BYTES) }, { text: 'x'.repeat(TEXT_MAX_BYTES), submit: true }]
	])('accepts %j', (body, want) => {
		expect(parseTerminalInput(body)).toEqual(want);
	});

	it.each([
		[{ key: 'C-[' }, 'unknown key'],
		[{ key: 'Enter; kill-server' }, 'unknown key'],
		[{ key: 'c-c' }, 'unknown key'],
		[{ key: 7 }, 'unknown key'],
		[{}, 'text or key is required'],
		[{ text: 42 }, 'text or key is required'],
		[{ text: 'x'.repeat(TEXT_MAX_BYTES + 1) }, `text is over ${TEXT_MAX_BYTES} bytes`],
		[{ text: 'é'.repeat(TEXT_MAX_BYTES / 2 + 1) }, `text is over ${TEXT_MAX_BYTES} bytes`]
	])('rejects %j', (body, message) => {
		expect(parseTerminalInput(body)).toEqual({ error: message });
	});
});

describe('parseSnapshotQuery', () => {
	const q = (s: string) => parseSnapshotQuery(new URLSearchParams(s));

	it.each([
		['', { lines: 500, h: null }],
		['lines=40', { lines: 40, h: null }],
		['lines=12.7', { lines: 12, h: null }],
		['lines=999999', { lines: SNAPSHOT_LINES_MAX, h: null }],
		['lines=-3', { lines: 500, h: null }],
		['lines=abc', { lines: 500, h: null }],
		['h=labc', { lines: 500, h: 'labc' }],
		['h=', { lines: 500, h: null }],
		[`h=${'z'.repeat(100)}`, { lines: 500, h: 'z'.repeat(64) }]
	])('%s', (query, want) => {
		expect(q(query)).toEqual(want);
	});
});
