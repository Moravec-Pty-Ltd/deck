import { describe, it, expect } from 'vitest';
import { composeZedSshCommand, composeZedUrl } from './zed-command-core';

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

	it('encodes the path so a space survives the shell', () => {
		expect(composeZedSshCommand({ cwd: '/srv/my app', host: 'h', user: 'u' })).toBe('zed ssh://u@h/srv/my%20app');
	});

	it('encodes what the shell would otherwise interpret', () => {
		expect(composeZedSshCommand({ cwd: "/srv/it's (a)!*;$x", host: 'h', user: 'u' })).toBe(
			'zed ssh://u@h/srv/it%27s%20%28a%29%21%2A%3B%24x'
		);
	});

	it('returns null when the session has no cwd', () => {
		expect(composeZedSshCommand({ cwd: undefined, host: 'h', user: 'u' })).toBeNull();
		expect(composeZedSshCommand({ cwd: '', host: 'h', user: 'u' })).toBeNull();
		expect(composeZedSshCommand({ cwd: '   ', host: 'h', user: 'u' })).toBeNull();
	});
});

describe('composeZedUrl', () => {
	it('composes the SSH deep link', () => {
		expect(composeZedUrl({ cwd: '/home/me/code/deck', host: 'box.tail.ts.net', user: 'me' })).toBe(
			'zed://ssh/me@box.tail.ts.net/home/me/code/deck'
		);
	});

	it('keeps the override verbatim, port included', () => {
		expect(composeZedUrl({ cwd: '/srv/app', host: 'h', user: 'u', override: 'deploy@ssh.example.com:2222' })).toBe(
			'zed://ssh/deploy@ssh.example.com:2222/srv/app'
		);
	});

	it('percent-encodes each path segment and keeps the slashes', () => {
		expect(composeZedUrl({ cwd: '/srv/my app/a#b+c%d é', host: 'h', user: 'u' })).toBe(
			'zed://ssh/u@h/srv/my%20app/a%23b%2Bc%25d%20%C3%A9'
		);
	});

	it('returns null when the session has no cwd', () => {
		expect(composeZedUrl({ cwd: null, host: 'h', user: 'u' })).toBeNull();
		expect(composeZedUrl({ cwd: '  ', host: 'h', user: 'u' })).toBeNull();
	});
});
