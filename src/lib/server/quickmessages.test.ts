import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// config.ts derives its data dir from the env at import time, so pin DECK_DATA to
// a throwaway dir before the store (which imports config) loads.
const originalDataDir = process.env.DECK_DATA;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-qm-'));
process.env.DECK_DATA = tmpDir;

const { listQuickMessages, saveQuickMessages } = await import('./quickmessages');

const FILE = path.join(tmpDir, 'quick-messages.json');

afterAll(() => {
	if (originalDataDir === undefined) delete process.env.DECK_DATA;
	else process.env.DECK_DATA = originalDataDir;
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('saveQuickMessages', () => {
	it('trims text and persists, round-tripping through listQuickMessages', () => {
		const saved = saveQuickMessages([{ id: 'a', label: 'Hi', text: '  hello  ' }]);
		expect(saved).toEqual([{ id: 'a', label: 'Hi', text: 'hello' }]);
		expect(listQuickMessages()).toEqual([{ id: 'a', label: 'Hi', text: 'hello' }]);
	});

	it('drops a label that trims to empty so the menu falls back to text', () => {
		expect(saveQuickMessages([{ id: 'a', label: '   ', text: 'x' }])).toEqual([
			{ id: 'a', text: 'x' }
		]);
		expect(saveQuickMessages([{ id: 'a', text: 'x' }])).toEqual([{ id: 'a', text: 'x' }]);
	});

	it('keeps a projectId through the round-trip and drops a blank one', () => {
		const saved = saveQuickMessages([
			{ id: 'a', text: 'x', projectId: '/path/to/project' },
			{ id: 'b', text: 'y', projectId: '  ' },
			{ id: 'c', label: 'L', text: 'z' }
		]);
		const expected = [
			{ id: 'a', text: 'x', projectId: '/path/to/project' },
			{ id: 'b', text: 'y' },
			{ id: 'c', label: 'L', text: 'z' }
		];
		expect(saved).toEqual(expected);
		expect(listQuickMessages()).toEqual(expected);
	});

	it('replaces the whole list (PUT semantics)', () => {
		saveQuickMessages([{ id: 'a', text: 'one' }]);
		const next = saveQuickMessages([{ id: 'b', text: 'two' }]);
		expect(next).toEqual([{ id: 'b', text: 'two' }]);
	});

	it('rejects non-array, missing/blank text, and bad ids', () => {
		expect(() => saveQuickMessages({})).toThrow();
		expect(() => saveQuickMessages([{ id: 'a' }])).toThrow();
		expect(() => saveQuickMessages([{ id: 'a', text: '   ' }])).toThrow();
		expect(() => saveQuickMessages([{ id: '', text: 'x' }])).toThrow();
	});

	it('rejects a list over the cap', () => {
		const tooMany = Array.from({ length: 201 }, (_, i) => ({ id: `id${i}`, text: `m${i}` }));
		expect(() => saveQuickMessages(tooMany)).toThrow();
	});
});

describe('listQuickMessages', () => {
	it('returns [] when the file is missing', () => {
		fs.rmSync(FILE, { force: true });
		expect(listQuickMessages()).toEqual([]);
	});

	it('tolerates a corrupt file', () => {
		fs.writeFileSync(FILE, 'not json');
		expect(listQuickMessages()).toEqual([]);
	});

	it('returns [] when the stored shape is invalid', () => {
		fs.writeFileSync(FILE, JSON.stringify([{ id: 'a' }]));
		expect(listQuickMessages()).toEqual([]);
	});
});
