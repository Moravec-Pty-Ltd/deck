import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES, safeUploadName, sharedFileMessage, uploadTooLarge } from './upload-core';

describe('safeUploadName', () => {
	it('keeps a name the user would recognise', () => {
		expect(safeUploadName('quarterly-report.pdf')).toBe('quarterly-report.pdf');
		expect(safeUploadName('IMG_0421.HEIC')).toBe('IMG_0421.HEIC');
	});

	it('takes only the last segment, so a path cannot escape the directory', () => {
		expect(safeUploadName('../../etc/passwd')).toBe('passwd');
		expect(safeUploadName('/tmp/notes.txt')).toBe('notes.txt');
		expect(safeUploadName('C:\\Users\\me\\notes.txt')).toBe('notes.txt');
	});

	it('replaces what a shell or filesystem would not want, collapsing runs', () => {
		expect(safeUploadName('my report (final) v2.pdf')).toBe('my-report-final-v2.pdf');
		expect(safeUploadName('a;rm -rf b.txt')).toBe('a-rm-rf-b.txt');
	});

	it('never starts with a dot or a dash', () => {
		expect(safeUploadName('.ssh')).toBe('ssh');
		expect(safeUploadName('-rf')).toBe('rf');
		expect(safeUploadName('...')).toBe('file');
	});

	it('falls back rather than returning nothing', () => {
		expect(safeUploadName('')).toBe('file');
		expect(safeUploadName('///')).toBe('file');
	});

	it('bounds the length', () => {
		expect(safeUploadName('x'.repeat(500))).toHaveLength(80);
	});
});

describe('uploadTooLarge', () => {
	it('accepts up to the limit and reports past it in MB', () => {
		expect(uploadTooLarge(MAX_UPLOAD_BYTES)).toBeNull();
		expect(uploadTooLarge(0)).toBeNull();
		const over = uploadTooLarge(MAX_UPLOAD_BYTES + 1024 * 1024);
		expect(over).toContain('26');
		expect(over).toContain('25');
	});
});

describe('sharedFileMessage', () => {
	it('names the path, singular and plural', () => {
		expect(sharedFileMessage(['/a/b.pdf'])).toBe('I have shared a file with you: /a/b.pdf');
		const many = sharedFileMessage(['/a/b.pdf', '/a/c.png']);
		expect(many).toContain('2 files');
		expect(many).toContain('- /a/c.png');
	});
});
