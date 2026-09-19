import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DeckSession } from '$lib/types';

// Fixture projects registered through a throwaway data dir before the import,
// the same way confine.test.ts does (realpath'd: the macOS tmpdir is a symlink).
const scratch = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `deck-files-${p}-`)));
const [dataDir, fakeHome, projRoot, outside] = ['data', 'home', 'proj', 'out'].map(scratch);
const prevDeckData = process.env.DECK_DATA;
process.env.DECK_DATA = dataDir;
vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

fs.mkdirSync(path.join(projRoot, 'shots'), { recursive: true });
fs.writeFileSync(path.join(projRoot, 'shots', 'a.png'), 'png-bytes');
fs.writeFileSync(path.join(projRoot, 'report.pdf'), 'pdf-bytes');
fs.writeFileSync(path.join(outside, 'secret.png'), 'nope');
fs.symlinkSync(path.join(outside, 'secret.png'), path.join(projRoot, 'link.png'));
fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([{ name: 'p', path: projRoot }]));

const { fileHeaders, resolveSessionFile, statSessionFiles, MAX_FILE_BYTES } = await import('./files');

afterAll(() => {
	vi.restoreAllMocks();
	if (prevDeckData === undefined) delete process.env.DECK_DATA;
	else process.env.DECK_DATA = prevDeckData;
	for (const d of [dataDir, projRoot, outside, fakeHome]) fs.rmSync(d, { recursive: true, force: true });
});

const session = { id: 'c_1', kind: 'claude', cwd: projRoot } as DeckSession;

describe('resolveSessionFile', () => {
	it('serves a file inside the project by absolute, relative and file URL mention', () => {
		const abs = path.join(projRoot, 'shots', 'a.png');
		for (const mention of [abs, './shots/a.png', `file://${abs}`]) {
			const file = resolveSessionFile(session, mention);
			expect(file?.absolute).toBe(abs);
			expect(file?.path).toBe(mention);
			expect(file).toMatchObject({ name: 'a.png', size: 9, mime: 'image/png', image: true });
		}
	});

	it('expands ~ against the home dir', () => {
		fs.mkdirSync(path.join(fakeHome, 'p'), { recursive: true });
		fs.writeFileSync(
			path.join(dataDir, 'projects.json'),
			JSON.stringify([
				{ name: 'p', path: projRoot },
				{ name: 'h', path: path.join(fakeHome, 'p') }
			])
		);
		fs.writeFileSync(path.join(fakeHome, 'p', 'h.txt'), 'hi');
		expect(resolveSessionFile(session, '~/p/h.txt')?.absolute).toBe(path.join(fakeHome, 'p', 'h.txt'));
	});

	it('refuses files outside the projects, symlinks out of them, directories, missing paths and huge files', () => {
		expect(resolveSessionFile(session, path.join(outside, 'secret.png'))).toBeNull();
		expect(resolveSessionFile(session, path.join(projRoot, 'link.png'))).toBeNull();
		expect(resolveSessionFile(session, path.join(projRoot, 'shots'))).toBeNull();
		expect(resolveSessionFile(session, path.join(projRoot, 'missing.png'))).toBeNull();
		expect(resolveSessionFile(session, '/tmp/x\0.png')).toBeNull();
		expect(resolveSessionFile(session, '')).toBeNull();
		const huge = path.join(projRoot, 'huge.bin');
		fs.writeFileSync(huge, '');
		fs.truncateSync(huge, MAX_FILE_BYTES + 1);
		expect(resolveSessionFile(session, huge)).toBeNull();
	});
});

describe('statSessionFiles', () => {
	it('keeps only the servable mentions, in order', () => {
		const files = statSessionFiles(session, ['./report.pdf', '/nowhere/z.png', './shots/a.png']);
		expect(files.map((f) => f.path)).toEqual(['./report.pdf', './shots/a.png']);
		expect(files[0]).toEqual({ path: './report.pdf', name: 'report.pdf', size: 9, mime: 'application/pdf', image: false });
	});
});

describe('fileHeaders', () => {
	const file = {
		path: './a.png',
		name: 'a b.png',
		size: 9,
		mime: 'image/png',
		image: true,
		absolute: '/x/a b.png',
		mtimeMs: 1700000000123.4
	};

	it('serves inline with an etag from size and mtime, or as an attachment', () => {
		expect(fileHeaders(file, false)).toEqual({
			'content-type': 'image/png',
			'cache-control': 'private, no-cache',
			'x-content-type-options': 'nosniff',
			etag: '"9-1700000000123"',
			'content-disposition': "inline; filename*=UTF-8''a%20b.png"
		});
		expect(fileHeaders(file, true)['content-disposition']).toBe("attachment; filename*=UTF-8''a%20b.png");
	});

	it('sandboxes scriptable documents only', () => {
		expect(fileHeaders({ ...file, mime: 'image/svg+xml' }, false)['content-security-policy']).toBe(
			"default-src 'none'; sandbox"
		);
		expect(fileHeaders({ ...file, mime: 'application/pdf' }, false)['content-security-policy']).toBeUndefined();
	});
});
