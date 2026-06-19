import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendLine } from './transcript-writer';

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-tw-'));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const read = (f: string) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);

describe('appendLine', () => {
	it('writes rapid concurrent appends in call order without interleaving', async () => {
		const f = path.join(dir, 't.jsonl');
		const lines = Array.from({ length: 50 }, (_, i) => `line-${i}\n`);
		await Promise.all(lines.map((l) => appendLine(f, l)));
		expect(read(f)).toEqual(lines.map((l) => l.trimEnd()));
	});

	it('defers the write off the event loop (nothing on disk synchronously)', async () => {
		const f = path.join(dir, 'deferred.jsonl');
		const p = appendLine(f, 'x\n');
		// The append is queued as a microtask, so the file cannot exist yet.
		expect(fs.existsSync(f)).toBe(false);
		await p;
		expect(read(f)).toEqual(['x']);
	});

	it('isolates a failed write so the file recovers on the next append', async () => {
		const f = path.join(dir, 'missing-parent', 'x.jsonl'); // parent absent -> ENOENT
		await expect(appendLine(f, 'a\n')).rejects.toThrow();
		fs.mkdirSync(path.join(dir, 'missing-parent'));
		await appendLine(f, 'b\n'); // a prior failure must not wedge the queue
		expect(read(f)).toEqual(['b']);
	});

	it('keeps separate files independent', async () => {
		const a = path.join(dir, 'a.jsonl');
		const b = path.join(dir, 'b.jsonl');
		await Promise.all([appendLine(a, '1\n'), appendLine(b, '2\n'), appendLine(a, '3\n')]);
		expect(read(a)).toEqual(['1', '3']);
		expect(read(b)).toEqual(['2']);
	});
});
