import { describe, expect, it } from 'vitest';
import { THEMES, THEME_COLOR, nextTheme, parseTheme, themeOption } from './theme-core';

describe('themes', () => {
	it('reads a stored theme and falls back to dark', () => {
		expect(parseTheme('light')).toBe('light');
		expect(parseTheme('eink')).toBe('eink');
		expect(parseTheme('sepia')).toBe('dark');
		expect(parseTheme(null)).toBe('dark');
		expect(parseTheme(undefined)).toBe('dark');
	});

	it('cycles dark, light, e-ink and back', () => {
		expect(nextTheme('dark').id).toBe('light');
		expect(nextTheme('light').id).toBe('eink');
		expect(nextTheme('eink').id).toBe('dark');
	});

	it('labels each theme and gives it a bar colour', () => {
		expect(themeOption('eink').label).toBe('E-ink');
		for (const t of THEMES) expect(THEME_COLOR[t.id]).toMatch(/^#[0-9a-f]{6}$/);
	});
});
