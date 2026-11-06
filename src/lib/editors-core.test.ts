import { describe, it, expect } from 'vitest';
import { composeEditorLinks, type EditorTarget } from './editors-core';

const link = (scheme: string, target: EditorTarget) => composeEditorLinks(target).find((e) => e.scheme === scheme);

describe('composeEditorLinks', () => {
	it('lists each editor with the URL scheme a client detects', () => {
		expect(composeEditorLinks({ cwd: '/srv/app', host: 'h', user: 'u' }).map((e) => [e.name, e.scheme])).toEqual([
			['Zed', 'zed'],
			['VS Code', 'vscode']
		]);
	});

	it('returns nothing when the session has no cwd', () => {
		for (const cwd of [undefined, null, '', '   ']) {
			expect(composeEditorLinks({ cwd, host: 'h', user: 'u' })).toEqual([]);
		}
	});
});

describe('Zed', () => {
	it('composes the command and link from the default user and host', () => {
		const zed = link('zed', { cwd: '/home/me/code/deck', host: 'box.tail.ts.net', user: 'me' });
		expect(zed?.command).toBe('zed ssh://me@box.tail.ts.net/home/me/code/deck');
		expect(zed?.url).toBe('zed://ssh/me@box.tail.ts.net/home/me/code/deck');
	});

	it('keeps the override verbatim, port included', () => {
		const zed = link('zed', { cwd: '/srv/app', host: 'ignored', user: 'ignored', override: 'deploy@ssh.example.com:2222' });
		expect(zed?.command).toBe('zed ssh://deploy@ssh.example.com:2222/srv/app');
		expect(zed?.url).toBe('zed://ssh/deploy@ssh.example.com:2222/srv/app');
	});

	it('treats a blank override as absent', () => {
		expect(link('zed', { cwd: '/srv/app', host: 'h', user: 'u', override: '  ' })?.command).toBe('zed ssh://u@h/srv/app');
	});

	it('encodes what the shell would otherwise interpret', () => {
		expect(link('zed', { cwd: "/srv/it's (a)!*;$x", host: 'h', user: 'u' })?.command).toBe(
			'zed ssh://u@h/srv/it%27s%20%28a%29%21%2A%3B%24x'
		);
	});

	it('percent-encodes each path segment and keeps the slashes', () => {
		expect(link('zed', { cwd: '/srv/my app/a#b+c%d é', host: 'h', user: 'u' })?.url).toBe(
			'zed://ssh/u@h/srv/my%20app/a%23b%2Bc%25d%20%C3%A9'
		);
	});
});

describe('VS Code', () => {
	it('composes the Remote - SSH link, with no command', () => {
		const vscode = link('vscode', { cwd: '/home/me/code/deck', host: 'box.tail.ts.net', user: 'me' });
		expect(vscode?.url).toBe('vscode://vscode-remote/ssh-remote+me@box.tail.ts.net/home/me/code/deck?windowId=_blank');
		expect(vscode?.command).toBeNull();
	});

	it('keeps the override verbatim, port included', () => {
		expect(link('vscode', { cwd: '/srv/app', host: 'h', user: 'u', override: 'deploy@ssh.example.com:2222' })?.url).toBe(
			'vscode://vscode-remote/ssh-remote+deploy@ssh.example.com:2222/srv/app?windowId=_blank'
		);
	});

	it('percent-encodes each path segment and keeps the slashes', () => {
		expect(link('vscode', { cwd: '/srv/my app/a#b+c%d é', host: 'h', user: 'u' })?.url).toBe(
			'vscode://vscode-remote/ssh-remote+u@h/srv/my%20app/a%23b%2Bc%25d%20%C3%A9?windowId=_blank'
		);
	});
});
