import { describe, expect, it } from 'vitest';
import { MAX_TITLE_LENGTH, parseTitle } from './session-title';

describe('parseTitle', () => {
	it('trims and collapses a title to one line', () => {
		expect(parseTitle('  auth   refactor \n round two ')).toEqual({
			ok: true,
			title: 'auth refactor round two'
		});
	});

	it('flattens control characters rather than storing them', () => {
		expect(parseTitle('auth\u0000\u001brefactor')).toEqual({ ok: true, title: 'auth refactor' });
	});

	it('refuses an empty, whitespace-only, or non-string title', () => {
		expect(parseTitle('')).toEqual({ ok: false, reason: 'title cannot be empty' });
		expect(parseTitle('   \n\t ')).toEqual({ ok: false, reason: 'title cannot be empty' });
		expect(parseTitle(undefined).ok).toBe(false);
		expect(parseTitle(42).ok).toBe(false);
		expect(parseTitle(['a']).ok).toBe(false);
	});

	it('refuses a title past the length cap, counted after trimming', () => {
		expect(parseTitle('a'.repeat(MAX_TITLE_LENGTH)).ok).toBe(true);
		expect(parseTitle(`  ${'a'.repeat(MAX_TITLE_LENGTH)}  `).ok).toBe(true);
		expect(parseTitle('a'.repeat(MAX_TITLE_LENGTH + 1))).toEqual({
			ok: false,
			reason: `title cannot be longer than ${MAX_TITLE_LENGTH} characters`
		});
	});
});
