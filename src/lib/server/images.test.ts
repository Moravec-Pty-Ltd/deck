import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// images.ts derives its directory from DECK_DATA at import, so point it at a
// throwaway dir before the module (and the config it imports) loads. Restore the
// env and remove the dir afterwards so nothing leaks to other suites in the worker.
const originalDataDir = process.env.DECK_DATA;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-images-'));
process.env.DECK_DATA = tmpDir;
const { persistImage, readImage } = await import('./images');

afterAll(() => {
	if (originalDataDir === undefined) delete process.env.DECK_DATA;
	else process.env.DECK_DATA = originalDataDir;
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// 1x1 transparent PNG.
const PNG =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('persistImage / readImage', () => {
	it('round-trips the bytes and media type through a content-addressed file', () => {
		const ref = persistImage('c_test', 'image/png', PNG);
		expect(ref.media_type).toBe('image/png');
		expect(ref.file).toMatch(/^[a-f0-9]{16}\.png$/);

		const read = readImage('c_test', ref.file);
		expect(read).not.toBeNull();
		expect(read!.media_type).toBe('image/png');
		expect(read!.data.equals(Buffer.from(PNG, 'base64'))).toBe(true);
	});

	it('is content-addressed: identical data maps to one file, different data to another', () => {
		const a = persistImage('c_test', 'image/png', PNG);
		const b = persistImage('c_test', 'image/png', PNG);
		const other = persistImage('c_test', 'image/png', Buffer.from('different').toString('base64'));
		expect(b.file).toBe(a.file);
		expect(other.file).not.toBe(a.file);
	});

	it('maps the jpeg media type to a .jpg file and back', () => {
		const ref = persistImage('c_test', 'image/jpeg', PNG);
		expect(ref.file).toMatch(/\.jpg$/);
		expect(readImage('c_test', ref.file)!.media_type).toBe('image/jpeg');
	});

	it('normalises the stored media type so the ref matches what is served', () => {
		const ref = persistImage('c_test', 'image/jpg', PNG);
		expect(ref.media_type).toBe('image/jpeg');
		expect(readImage('c_test', ref.file)!.media_type).toBe(ref.media_type);
	});

	it('sanitizes the session id consistently on write and read', () => {
		const ref = persistImage('a/b../c', 'image/png', PNG);
		expect(readImage('a/b../c', ref.file)).not.toBeNull();
	});

	it('rejects filenames that are not content-addressed (traversal, bad shape)', () => {
		expect(readImage('c_test', '../../etc/passwd')).toBeNull();
		expect(readImage('c_test', 'notahash.png')).toBeNull();
		expect(readImage('c_test', 'deadbeefdeadbeef.exe')).toBeNull();
	});

	it('returns null for a well-formed name with no backing file', () => {
		expect(readImage('c_test', 'deadbeefdeadbeef.png')).toBeNull();
	});

	it('throws on a media type it cannot store as a readable file', () => {
		expect(() => persistImage('c_test', 'image/svg+xml', PNG)).toThrow();
	});
});
