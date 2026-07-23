import { describe, it, expect } from 'vitest';
import { composeZedSshCommand } from './zed-command-core';

describe('composeZedSshCommand', () => {
	it('composes from default user and host', () => {
		expect(composeZedSshCommand({ cwd: '/home/me/code/deck', host: 'box.tail.ts.net', user: 'me' })).toBe(
			'zed ssh://me@box.tail.ts.net/home/me/code/deck'
		);
	});

	it('prefers the user@host override over the defaults', () => {
		expect(
			composeZedSshCommand({
				cwd: '/srv/app',
				host: 'box.tail.ts.net',
				user: 'me',
				override: 'deploy@ssh.example.com:2222'
			})
		).toBe('zed ssh://deploy@ssh.example.com:2222/srv/app');
	});

	it('ignores a blank override', () => {
		expect(composeZedSshCommand({ cwd: '/srv/app', host: 'h', user: 'u', override: '   ' })).toBe(
			'zed ssh://u@h/srv/app'
		);
	});

	it('returns null when the session has no cwd', () => {
		expect(composeZedSshCommand({ cwd: undefined, host: 'h', user: 'u' })).toBeNull();
		expect(composeZedSshCommand({ cwd: '', host: 'h', user: 'u' })).toBeNull();
		expect(composeZedSshCommand({ cwd: '   ', host: 'h', user: 'u' })).toBeNull();
	});
});
