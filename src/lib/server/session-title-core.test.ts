import { describe, expect, it } from 'vitest';
import { adhocId, adhocTmuxName, isAdhocId, tmuxSessionName } from './session-title-core';

describe('tmuxSessionName', () => {
	it('drops colons, which would make the session unreachable by name', () => {
		expect(tmuxSessionName('build: web')).toBe('build- web');
		expect(tmuxSessionName('a:b:c')).toBe('a-b-c');
	});

	it('keeps dots and spaces, which tmux targets happily', () => {
		expect(tmuxSessionName('v2.1 deploy')).toBe('v2.1 deploy');
	});
});

describe('adhoc ids', () => {
	it('round-trips a tmux name through its derived id', () => {
		expect(adhocId('morabot')).toBe('t_morabot');
		expect(adhocTmuxName('t_morabot')).toBe('morabot');
		expect(adhocTmuxName(adhocId('two words'))).toBe('two words');
	});

	it('tells an adhoc id from a stored one', () => {
		expect(isAdhocId('t_morabot')).toBe(true);
		expect(isAdhocId('c_abc123')).toBe(false);
		expect(isAdhocId('s_abc123')).toBe(false);
	});
});
