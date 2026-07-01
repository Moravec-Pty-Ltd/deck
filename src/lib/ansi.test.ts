import { describe, it, expect } from 'vitest';
import { parseAnsi } from './ansi';

const ESC = '\x1b';

describe('parseAnsi', () => {
	it('returns a single plain segment for unstyled text', () => {
		const segs = parseAnsi('hello world');
		expect(segs).toHaveLength(1);
		expect(segs[0].text).toBe('hello world');
		expect(segs[0].fg).toBeUndefined();
	});

	it('applies basic foreground colour and clears it on default-fg (39)', () => {
		const segs = parseAnsi(`${ESC}[31mred${ESC}[39m plain`);
		expect(segs.map((s) => s.text)).toEqual(['red', ' plain']);
		expect(segs[0].fg).toBe('#cc0000');
		expect(segs[1].fg).toBeUndefined();
	});

	it('clears fg/bg on a full reset (SGR 0), not just boolean attributes', () => {
		const segs = parseAnsi(`${ESC}[31;44mred${ESC}[0m plain`);
		expect(segs.map((s) => s.text)).toEqual(['red', ' plain']);
		expect(segs[0].fg).toBe('#cc0000');
		expect(segs[0].bg).toBe('#3465a4');
		expect(segs[1].fg).toBeUndefined();
		expect(segs[1].bg).toBeUndefined();
	});

	it('treats an empty SGR (ESC[m) as a reset of attributes', () => {
		const segs = parseAnsi(`${ESC}[1mbold${ESC}[mafter`);
		expect(segs[0].bold).toBe(true);
		expect(segs[1].text).toBe('after');
		expect(segs[1].bold).toBe(false);
	});

	it('handles 256-colour and truecolor sequences', () => {
		const segs = parseAnsi(`${ESC}[38;5;196mx${ESC}[38;2;10;20;30my`);
		expect(segs[0].fg).toBe('rgb(255,0,0)');
		expect(segs[1].fg).toBe('rgb(10,20,30)');
	});

	it('tracks inverse and combined attributes', () => {
		const segs = parseAnsi(`${ESC}[7minv${ESC}[27mnorm`);
		expect(segs[0].inverse).toBe(true);
		expect(segs[1].inverse).toBe(false);
	});

	it('strips OSC hyperlink/title sequences without leaking them', () => {
		const osc = `${ESC}]8;;https://example.com${ESC}\\link${ESC}]8;;${ESC}\\`;
		const segs = parseAnsi(`before ${osc} after`);
		const joined = segs.map((s) => s.text).join('');
		expect(joined).toContain('link');
		expect(joined).not.toContain(ESC);
		expect(joined).not.toContain('example.com');
	});

	it('strips a bell-terminated OSC title', () => {
		const segs = parseAnsi(`a${ESC}]0;window title\x07b`);
		expect(segs.map((s) => s.text).join('')).toBe('ab');
	});

	it('drops stray cursor-move CSI codes', () => {
		const segs = parseAnsi(`one${ESC}[2Atwo${ESC}[Kthree`);
		const joined = segs.map((s) => s.text).join('');
		expect(joined).toBe('onetwothree');
		expect(joined).not.toContain(ESC);
	});

	it('drops CSI sequences with non-letter final bytes (bracketed paste)', () => {
		const segs = parseAnsi(`a${ESC}[200~paste${ESC}[201~b`);
		const joined = segs.map((s) => s.text).join('');
		expect(joined).toBe('apasteb');
		expect(joined).not.toContain('~');
	});

	it('drops private-mode CSI toggles', () => {
		const segs = parseAnsi(`x${ESC}[?2004hy${ESC}[?25lz`);
		expect(segs.map((s) => s.text).join('')).toBe('xyz');
	});

	it('keeps styling across a stripped escape', () => {
		const segs = parseAnsi(`${ESC}[32ma${ESC}[Kb`);
		expect(segs.every((s) => s.fg === '#4e9a06')).toBe(true);
		expect(segs.map((s) => s.text).join('')).toBe('ab');
	});

	it('returns nothing for empty input', () => {
		expect(parseAnsi('')).toEqual([]);
	});
});
