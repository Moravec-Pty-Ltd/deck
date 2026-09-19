import { describe, expect, it } from 'vitest';
import { basename, extensionOf, findFilePaths, formatBytes, isImagePath, mimeFor, scriptable } from './files-core';

describe('findFilePaths', () => {
	it('finds absolute, home, file URL and explicit relative paths', () => {
		expect(
			findFilePaths(
				'Saved to /tmp/shot.png and ~/Desktop/report.pdf, see file:///Users/me/a.csv or ./out/b.json and ../c.txt'
			)
		).toEqual(['/tmp/shot.png', '~/Desktop/report.pdf', '/Users/me/a.csv', './out/b.json', '../c.txt']);
	});

	it('drops sentence punctuation and wrapping quotes, brackets and backticks', () => {
		expect(findFilePaths('Done: /tmp/a.png. Also (`/tmp/b.jpg`), "/tmp/c.gif"; [/tmp/d.webp]!')).toEqual([
			'/tmp/a.png',
			'/tmp/b.jpg',
			'/tmp/c.gif',
			'/tmp/d.webp'
		]);
	});

	it('keeps a dotted name whole and a line suffix out', () => {
		expect(findFilePaths('/tmp/a.png.bak and /src/x.test.ts:12')).toEqual(['/tmp/a.png.bak', '/src/x.test.ts']);
	});

	it('ignores URL paths, bare relative references and directories', () => {
		expect(findFilePaths('see https://example.com/a.png and src/lib/foo.ts in /Users/me/proj/')).toEqual([]);
	});

	it('dedupes and caps the list', () => {
		expect(findFilePaths('/a/b.png /a/b.png /a/c.png')).toEqual(['/a/b.png', '/a/c.png']);
		const many = Array.from({ length: 30 }, (_, i) => `/a/${i}.png`).join(' ');
		expect(findFilePaths(many)).toHaveLength(20);
	});
});

describe('file helpers', () => {
	it('classifies images by extension', () => {
		expect(isImagePath('/a/b.PNG')).toBe(true);
		expect(isImagePath('/a/b.pdf')).toBe(false);
		expect(isImagePath('/a/noext')).toBe(false);
	});

	it('names, extensions and mimes', () => {
		expect(basename('/a/b/c.txt')).toBe('c.txt');
		expect(extensionOf('/a/.hidden')).toBe('');
		expect(mimeFor('/a/b.jpeg')).toBe('image/jpeg');
		expect(mimeFor('/a/b.xyz')).toBe('application/octet-stream');
		expect(scriptable('image/svg+xml')).toBe(true);
		expect(scriptable('text/html')).toBe(true);
		expect(scriptable('application/pdf')).toBe(false);
	});

	it('formats sizes', () => {
		expect(formatBytes(512)).toBe('512 B');
		expect(formatBytes(2048)).toBe('2.0 KB');
		expect(formatBytes(200 * 1024)).toBe('200 KB');
		expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
	});
});
