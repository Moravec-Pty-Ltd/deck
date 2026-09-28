import { describe, expect, it } from 'vitest';
import { lineMayMatch, matchSessionNames, normaliseQuery, searchableText, snippetAround } from './search-core';

describe('search core', () => {
	it('prefilters raw lines case-insensitively', () => {
		expect(lineMayMatch('{"type":"deck.user","text":"Fix the Auth middleware"}', 'auth')).toBe(true);
		expect(lineMayMatch('{"type":"deck.user","text":"nothing here"}', 'auth')).toBe(false);
	});

	it('reads user prompts and assistant text, not tools', () => {
		expect(searchableText({ type: 'deck.user', text: 'hi' })).toEqual({ role: 'user', text: 'hi' });
		expect(searchableText({ type: 'assistant', message: { content: [{ type: 'text', text: 'a' }, { type: 'tool_use', name: 'Bash' }, { type: 'text', text: 'b' }] } })).toEqual({ role: 'assistant', text: 'a\nb' });
		expect(searchableText({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } })).toBeNull();
		expect(searchableText({ type: 'user', message: { content: [{ type: 'tool_result', content: 'auth' }] } })).toBeNull();
	});

	it('snips around the match on one line', () => {
		const text = 'x'.repeat(100) + '\n\nThe auth middleware\nrejects it. ' + 'y'.repeat(100);
		const snippet = snippetAround(text, 'AUTH', 10);
		expect(snippet).toBe('…xxxxx The auth middlewar…');
		expect(snippetAround('auth', 'auth')).toBe('auth');
		expect(snippetAround('nothing', 'auth')).toBeNull();
	});

	it('normalises queries', () => {
		expect(normaliseQuery('  auth   middleware ')).toBe('auth middleware');
		expect(normaliseQuery(null)).toBe('');
	});
});

describe('matchSessionNames', () => {
	const sessions = [
		{ id: 'c_1', title: 'deck enhancements' },
		{ id: 'c_2', title: 'deck' },
		{ id: 'c_3', title: 'Auth: token refresh' },
		{ id: 'c_4', title: 'unrelated work' },
		{ id: 'c_5', title: '' },
		{ id: 'c_6' }
	];

	it('finds every session whose title holds all the words, in any order', () => {
		expect(matchSessionNames('auth token', sessions).map((m) => m.id)).toEqual(['c_3']);
		expect(matchSessionNames('token auth', sessions).map((m) => m.id)).toEqual(['c_3']);
	});

	it('puts an exact title first, then a prefix, then the rest', () => {
		// 'deck' is exact for c_2 and a prefix for c_1.
		expect(matchSessionNames('deck', sessions).map((m) => m.id)).toEqual(['c_2', 'c_1']);
	});

	it('keeps the caller order within a rank, so recency survives', () => {
		const recent = [
			{ id: 'newer', title: 'build the thing' },
			{ id: 'older', title: 'build the other thing' }
		];
		expect(matchSessionNames('build', recent).map((m) => m.id)).toEqual(['newer', 'older']);
	});

	it('ignores case and surrounding whitespace', () => {
		expect(matchSessionNames('  AUTH  ', sessions).map((m) => m.id)).toEqual(['c_3']);
	});

	it('returns nothing for a query below the minimum, or with no match', () => {
		expect(matchSessionNames('a', sessions)).toEqual([]);
		expect(matchSessionNames('', sessions)).toEqual([]);
		expect(matchSessionNames('nothing like this', sessions)).toEqual([]);
	});

	it('skips sessions with no title rather than matching them', () => {
		expect(matchSessionNames('deck', sessions).some((m) => m.id === 'c_5' || m.id === 'c_6')).toBe(false);
	});
});
