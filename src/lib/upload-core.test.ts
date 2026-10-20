import { describe, expect, it } from 'vitest';
import {
	MAX_UPLOAD_BYTES,
	MAX_UPLOAD_FILES,
	admitUploads,
	formatBytes,
	isInlineImage,
	safeUploadName,
	sharedFileMessage,
	uploadTooLarge
} from './upload-core';

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

describe('isInlineImage', () => {
	it('takes the types a model reads inline and nothing else', () => {
		for (const t of ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']) expect(isInlineImage(t)).toBe(true);
		for (const t of ['image/svg+xml', 'image/heic', 'application/pdf', '']) expect(isInlineImage(t)).toBe(false);
	});
});

describe('formatBytes', () => {
	it('picks a unit a person reads at a glance', () => {
		expect(formatBytes(512)).toBe('512 B');
		expect(formatBytes(1536)).toBe('1.5 KB');
		expect(formatBytes(2048)).toBe('2 KB');
		expect(formatBytes(3 * 1024 * 1024)).toBe('3 MB');
	});
});

describe('admitUploads', () => {
	const file = (name: string, size = 10) => ({ name, size });

	it('admits files within both limits', () => {
		const { admitted, errors } = admitUploads(0, [file('a.pdf'), file('b.log', MAX_UPLOAD_BYTES)]);
		expect(admitted.map((f) => f.name)).toEqual(['a.pdf', 'b.log']);
		expect(errors).toEqual([]);
	});

	it('names an oversized file and its size', () => {
		const { admitted, errors } = admitUploads(0, [file('big.zip', MAX_UPLOAD_BYTES + 1024 * 1024), file('ok.txt')]);
		expect(admitted.map((f) => f.name)).toEqual(['ok.txt']);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(/^big\.zip: file is 26 MB; the limit is 25 MB$/);
	});

	it('counts files already held against the per-message cap', () => {
		const incoming = [file('x1'), file('x2'), file('x3')];
		const { admitted, errors } = admitUploads(MAX_UPLOAD_FILES - 1, incoming);
		expect(admitted.map((f) => f.name)).toEqual(['x1']);
		expect(errors).toEqual([`at most ${MAX_UPLOAD_FILES} files per message; left out x2, x3`]);
	});
});
