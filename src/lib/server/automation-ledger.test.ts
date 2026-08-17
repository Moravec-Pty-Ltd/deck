import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point the data dir at a throwaway tmpdir before importing, so the module's
// config side effects (mkdir, token) and every read/write land there.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-ledger-test-'));
process.env.DECK_DATA = dataDir;
const file = path.join(dataDir, 'automation.json');

const { loadProcessed, persist } = await import('./automation-ledger');

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

// Another process writing the ledger: mtime has 1ms resolution on some
// filesystems, so stamp it forward explicitly rather than relying on the clock.
function foreignWrite(processed: Record<string, number>) {
	fs.writeFileSync(file, JSON.stringify({ processed }));
	const future = new Date(Date.now() + 5000);
	fs.utimesSync(file, future, future);
}

describe('automation ledger', () => {
	it('round-trips claims and serves them from cache', () => {
		persist({ 'auto:work:a': 1 });
		expect(loadProcessed()).toEqual({ 'auto:work:a': 1 });
		expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ processed: { 'auto:work:a': 1 } });
	});

	it('re-reads when another writer moves the file mtime', () => {
		persist({ 'auto:work:a': 1 });
		foreignWrite({ 'auto:work:b': 2 });
		expect(loadProcessed()).toEqual({ 'auto:work:b': 2 });
	});

	it('does not drop a concurrent writer claim on the next persist', () => {
		persist({ 'auto:work:a': 1 });
		foreignWrite({ 'auto:work:a': 1, 'auto:review:c': 3 });
		const processed = loadProcessed();
		processed['auto:work:d'] = 4;
		persist(processed);
		expect(JSON.parse(fs.readFileSync(file, 'utf8')).processed).toEqual({
			'auto:work:a': 1,
			'auto:review:c': 3,
			'auto:work:d': 4
		});
	});
});
