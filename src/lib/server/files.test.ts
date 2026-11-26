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

const { fileHeaders, openServed, resolveSessionFile, saveSessionFile, sha256Hex, statSessionFiles, MAX_FILE_BYTES } = await import('./files');

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

describe('openServed', () => {
	it('refuses a file swapped for a link after it was resolved', () => {
		const file = path.join(projRoot, 'swap.txt');
		fs.writeFileSync(file, 'ok');
		const resolved = resolveSessionFile(session, file)!;
		const fd = openServed(resolved)!;
		expect(fs.readFileSync(fd, 'utf8')).toBe('ok');
		fs.closeSync(fd);
		fs.rmSync(file);
		fs.symlinkSync(path.join(outside, 'secret.png'), file);
		expect(openServed(resolved)).toBeNull();
		fs.rmSync(file);

		const dir = path.join(projRoot, 'moved');
		fs.mkdirSync(dir);
		fs.writeFileSync(path.join(dir, 'secret.png'), 'ok');
		const inDir = resolveSessionFile(session, path.join(dir, 'secret.png'))!;
		fs.rmSync(dir, { recursive: true });
		fs.symlinkSync(outside, dir);
		expect(openServed(inDir)).toBeNull();
		fs.rmSync(dir);
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
			'accept-ranges': 'bytes',
			etag: '"9-1700000000123"',
			'content-disposition': "inline; filename*=UTF-8''a%20b.png"
		});
		expect(fileHeaders(file, true)['content-disposition']).toBe("attachment; filename*=UTF-8''a%20b.png");
	});

	it('labels text as UTF-8 so accented letters survive, and leaves binary types alone', () => {
		expect(fileHeaders({ ...file, mime: 'text/markdown' }, false)['content-type']).toBe('text/markdown; charset=utf-8');
		expect(fileHeaders({ ...file, mime: 'text/plain' }, false)['content-type']).toBe('text/plain; charset=utf-8');
		expect(fileHeaders({ ...file, mime: 'application/json' }, false)['content-type']).toBe('application/json; charset=utf-8');
		expect(fileHeaders({ ...file, mime: 'image/svg+xml' }, false)['content-type']).toBe('image/svg+xml; charset=utf-8');
		expect(fileHeaders({ ...file, mime: 'application/pdf' }, false)['content-type']).toBe('application/pdf');
	});

	it('sandboxes scriptable documents only', () => {
		expect(fileHeaders({ ...file, mime: 'image/svg+xml' }, false)['content-security-policy']).toBe(
			"default-src 'none'; sandbox"
		);
		expect(fileHeaders({ ...file, mime: 'application/pdf' }, false)['content-security-policy']).toBeUndefined();
	});
});

describe('saveSessionFile', () => {
	const env = path.join(projRoot, '.env');
	const reset = (text: string) => {
		fs.writeFileSync(env, text, { mode: 0o600 });
		fs.chmodSync(env, 0o600);
	};

	it('replaces the text atomically and keeps mode 0600', () => {
		reset('A=1\n');
		const res = saveSessionFile(session, env, 'A=2\n', sha256Hex('A=1\n'));
		expect(res).toEqual({ ok: true, sha256: sha256Hex('A=2\n'), size: 4 });
		expect(fs.readFileSync(env, 'utf8')).toBe('A=2\n');
		expect(fs.statSync(env).mode & 0o777).toBe(0o600);
		expect(fs.readdirSync(projRoot).filter((n) => n.endsWith('.tmp'))).toEqual([]);
	});

	it('answers 409 for a stale hash and leaves the file alone', () => {
		reset('A=1\n');
		expect(saveSessionFile(session, env, 'A=2\n', sha256Hex('old'))).toMatchObject({ ok: false, status: 409 });
		expect(fs.readFileSync(env, 'utf8')).toBe('A=1\n');
	});

	it('refuses paths outside the project and missing files', () => {
		const stray = path.join(outside, 'stray.txt');
		fs.writeFileSync(stray, 'x');
		expect(saveSessionFile(session, stray, 'y', sha256Hex('x'))).toMatchObject({ ok: false, status: 404 });
		expect(saveSessionFile(session, path.join(projRoot, 'nope.txt'), 'y', '')).toMatchObject({ ok: false, status: 404 });
		expect(fs.readFileSync(stray, 'utf8')).toBe('x');
	});

	it("refuses git's own files and another project's files", () => {
		const other = scratch('other');
		fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([{ name: 'p', path: projRoot }, { name: 'o', path: other }]));
		const save = (file: string) => {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, 'x');
			return saveSessionFile(session, file, 'y', sha256Hex('x'));
		};
		for (const file of [path.join(projRoot, '.git', 'config'), path.join(projRoot, 'sub', '.GIT', 'notes.txt'), path.join(other, 'a.txt')]) {
			expect(save(file)).toMatchObject({ ok: false, status: 403 });
			expect(fs.readFileSync(file, 'utf8')).toBe('x');
		}
		for (const file of [path.join(projRoot, '.gitignore'), path.join(`${projRoot}-worktrees`, 'feature', 'a.txt')]) expect(save(file)).toMatchObject({ ok: true });
		fs.rmSync(other, { recursive: true });
		fs.rmSync(`${projRoot}-worktrees`, { recursive: true });
	});

	it('refuses binary and oversized files and oversized text', () => {
		const bin = path.join(projRoot, 'blob.txt');
		fs.writeFileSync(bin, 'a\0b');
		expect(saveSessionFile(session, bin, 'y', sha256Hex('a\0b'))).toMatchObject({ ok: false, status: 400 });
		expect(saveSessionFile(session, path.join(projRoot, 'shots', 'a.png'), 'y', '')).toMatchObject({ ok: false, status: 400 });
		const big = path.join(projRoot, 'big.txt');
		fs.writeFileSync(big, 'x'.repeat(1024 * 1024 + 1));
		expect(saveSessionFile(session, big, 'y', '')).toMatchObject({ ok: false, status: 413 });
		reset('A=1\n');
		expect(saveSessionFile(session, env, 'x'.repeat(1024 * 1024 + 1), sha256Hex('A=1\n'))).toMatchObject({ ok: false, status: 413 });
	});
});
