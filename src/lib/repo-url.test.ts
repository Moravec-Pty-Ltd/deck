import { describe, it, expect } from 'vitest';
import { repoNameFromUrl, isCloneUrlSafe } from './repo-url';

describe('repoNameFromUrl', () => {
	it('derives the name from https, ssh, scp-style, and aliased urls', () => {
		expect(repoNameFromUrl('https://github.com/acme/web.git')).toBe('web');
		expect(repoNameFromUrl('https://github.com/acme/web')).toBe('web');
		expect(repoNameFromUrl('https://github.com/acme/web/')).toBe('web');
		expect(repoNameFromUrl('git@github.com:acme/web.git')).toBe('web');
		expect(repoNameFromUrl('ssh://git@github.com/acme/web.git')).toBe('web');
		expect(repoNameFromUrl('ssh://git@github.com:22/acme/web.git')).toBe('web');
		expect(repoNameFromUrl('git@github-work:acme/web.git')).toBe('web');
		expect(repoNameFromUrl('  https://github.com/acme/web.git\n')).toBe('web');
	});

	it('strips only a trailing .git and surrounding slashes', () => {
		expect(repoNameFromUrl('https://github.com/acme/web.js.git')).toBe('web.js');
		expect(repoNameFromUrl('https://github.com/acme/web.git/')).toBe('web');
		expect(repoNameFromUrl('git@github.com:acme/dot.name')).toBe('dot.name');
	});

	it('returns null when no name can be derived', () => {
		expect(repoNameFromUrl('')).toBeNull();
		expect(repoNameFromUrl('   ')).toBeNull();
	});
});

describe('isCloneUrlSafe', () => {
	it('allows https, ssh, git, and scp-style urls', () => {
		expect(isCloneUrlSafe('https://github.com/acme/web.git')).toBe(true);
		expect(isCloneUrlSafe('ssh://git@github.com/acme/web.git')).toBe(true);
		expect(isCloneUrlSafe('ssh://git@github.com:22/acme/web.git')).toBe(true);
		expect(isCloneUrlSafe('git://github.com/acme/web.git')).toBe(true);
		expect(isCloneUrlSafe('git@github.com:acme/web.git')).toBe(true);
		expect(isCloneUrlSafe('git@github-work:acme/web.git')).toBe(true);
	});

	it('rejects the ext:: transport trick, file://, and local/option-like urls', () => {
		expect(isCloneUrlSafe("ext::sh -c 'touch pwned'")).toBe(false);
		expect(isCloneUrlSafe('file:///Users/me/acme/web')).toBe(false);
		expect(isCloneUrlSafe('http://github.com/acme/web.git')).toBe(false);
		expect(isCloneUrlSafe('-oProxyCommand=evil')).toBe(false);
		expect(isCloneUrlSafe('--upload-pack=evil')).toBe(false);
		expect(isCloneUrlSafe('C:/Users/me/acme/web')).toBe(false);
		expect(isCloneUrlSafe('/home/me/acme/web')).toBe(false);
		expect(isCloneUrlSafe('../acme/web')).toBe(false);
		expect(isCloneUrlSafe('')).toBe(false);
	});

	it('rejects Windows drive paths and backslash urls', () => {
		expect(isCloneUrlSafe('C:\\Users\\me\\repo')).toBe(false);
		expect(isCloneUrlSafe('C:repo')).toBe(false);
		expect(isCloneUrlSafe('..\\..\\evil')).toBe(false);
		expect(isCloneUrlSafe('git@host:acme\\..\\evil')).toBe(false);
	});
});
