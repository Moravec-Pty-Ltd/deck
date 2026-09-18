import { describe, expect, it } from 'vitest';
import { lineMayMatch, normaliseQuery, searchableText, snippetAround } from './search-core';

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
