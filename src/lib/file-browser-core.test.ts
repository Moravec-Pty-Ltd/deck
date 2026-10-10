import { describe, expect, it } from 'vitest';
import {
	cleanRelPath,
	crumbs,
	isSecretName,
	isTucked,
	langFor,
	looksBinary,
	parentRel,
	sortEntries,
	viewerFor,
	type DirEntry
} from './file-browser-core';

const entry = (name: string, dir = false): DirEntry => ({ name, dir, size: 0, mtimeMs: 0 });

describe('sortEntries', () => {
	it('puts folders first, then names in natural, case-insensitive order', () => {
		const sorted = sortEntries([entry('b.md'), entry('src', true), entry('A.md'), entry('a10.txt'), entry('a2.txt'), entry('Docs', true)]);
		expect(sorted.map((e) => e.name)).toEqual(['Docs', 'src', 'A.md', 'a2.txt', 'a10.txt', 'b.md']);
	});
});

describe('isTucked', () => {
	it('tucks dotfiles and generated folders', () => {
		expect(isTucked(entry('.env'))).toBe(true);
		expect(isTucked(entry('.git', true))).toBe(true);
		expect(isTucked(entry('node_modules', true))).toBe(true);
		expect(isTucked(entry('build', true))).toBe(true);
	});
	it('keeps ordinary entries, including a file named like a noise folder', () => {
		expect(isTucked(entry('src', true))).toBe(false);
		expect(isTucked(entry('README.md'))).toBe(false);
		expect(isTucked(entry('build'))).toBe(false);
	});
});

describe('isSecretName', () => {
	it('flags env files, keys and credential files', () => {
		for (const n of ['.env', '.env.local', '.env.production', 'prod.env', 'server.pem', 'tls.key', 'id_ed25519', 'credentials.json', 'secrets.yaml', '.npmrc']) {
			expect(isSecretName(n), n).toBe(true);
		}
	});
	it('leaves templates and ordinary files alone', () => {
		for (const n of ['.env.example', '.env.sample', '.env.template', 'README.md', 'id_ed25519.pub', 'environment.ts', 'keys.ts']) {
			expect(isSecretName(n), n).toBe(false);
		}
	});
});

describe('viewerFor', () => {
	it('picks a viewer by extension', () => {
		expect(viewerFor('README.md')).toBe('markdown');
		expect(viewerFor('shot.PNG')).toBe('image');
		expect(viewerFor('logo.svg')).toBe('image');
		expect(viewerFor('report.pdf')).toBe('pdf');
		expect(viewerFor('clip.mp4')).toBe('video');
		expect(viewerFor('note.m4a')).toBe('audio');
		expect(viewerFor('bundle.zip')).toBe('binary');
	});
	it('tries anything else as text', () => {
		expect(viewerFor('main.ts')).toBe('text');
		expect(viewerFor('Dockerfile')).toBe('text');
		expect(viewerFor('LICENSE')).toBe('text');
	});
});

describe('langFor', () => {
	it('maps extensions and well-known names to highlighter languages', () => {
		expect(langFor('app.ts')).toBe('typescript');
		expect(langFor('page.svelte')).toBe('svelte');
		expect(langFor('compose.yml')).toBe('yaml');
		expect(langFor('Dockerfile')).toBe('docker');
		expect(langFor('.env.local')).toBe('ini');
	});
	it('leaves unknown files plain', () => {
		expect(langFor('LICENSE')).toBe('');
		expect(langFor('data.xyz')).toBe('');
	});
});

describe('looksBinary', () => {
	it('spots NUL bytes and invalid UTF-8', () => {
		expect(looksBinary('abc\0def')).toBe(true);
		expect(looksBinary('���ab')).toBe(true);
	});
	it('accepts text, including non-ASCII', () => {
		expect(looksBinary('Příliš žluťoučký kůň\n')).toBe(false);
		expect(looksBinary('')).toBe(false);
	});
});

describe('cleanRelPath', () => {
	it('normalises separators and dots', () => {
		expect(cleanRelPath('')).toBe('');
		expect(cleanRelPath('/src//lib/./x/')).toBe('src/lib/x');
	});
	it('refuses to climb out or smuggle separators', () => {
		expect(cleanRelPath('..')).toBeNull();
		expect(cleanRelPath('src/../../etc')).toBeNull();
		expect(cleanRelPath('a\\..\\b')).toBeNull();
		expect(cleanRelPath('a\0b')).toBeNull();
	});
});

describe('paths', () => {
	it('walks up and builds crumbs from the session folder', () => {
		expect(parentRel('src/lib/x.ts')).toBe('src/lib');
		expect(parentRel('x.ts')).toBe('');
		expect(crumbs('/path/to/project', 'src/lib')).toEqual([
			{ label: 'project', path: '' },
			{ label: 'src', path: 'src' },
			{ label: 'lib', path: 'src/lib' }
		]);
	});
});
