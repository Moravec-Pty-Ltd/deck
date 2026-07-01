import { describe, it, expect } from 'vitest';
import {
	clampSidebarWidth,
	parseSidebarWidth,
	SIDEBAR_MIN,
	SIDEBAR_MAX,
	SIDEBAR_DEFAULT
} from './sidebar-width';

describe('clampSidebarWidth', () => {
	it('keeps a value inside the range', () => {
		expect(clampSidebarWidth(300)).toBe(300);
	});

	it('clamps below the minimum and above the maximum', () => {
		expect(clampSidebarWidth(50)).toBe(SIDEBAR_MIN);
		expect(clampSidebarWidth(1000)).toBe(SIDEBAR_MAX);
	});

	it('rounds to whole pixels', () => {
		expect(clampSidebarWidth(240.7)).toBe(241);
	});

	it('falls back to the default for non-finite input', () => {
		expect(clampSidebarWidth(NaN)).toBe(SIDEBAR_DEFAULT);
		expect(clampSidebarWidth(Infinity)).toBe(SIDEBAR_DEFAULT);
	});
});

describe('parseSidebarWidth', () => {
	it('defaults when the value is absent', () => {
		expect(parseSidebarWidth(null)).toBe(SIDEBAR_DEFAULT);
	});

	it('defaults on an unparseable value', () => {
		expect(parseSidebarWidth('wide')).toBe(SIDEBAR_DEFAULT);
	});

	it('parses and clamps a stored value', () => {
		expect(parseSidebarWidth('300')).toBe(300);
		expect(parseSidebarWidth('9999')).toBe(SIDEBAR_MAX);
	});
});
