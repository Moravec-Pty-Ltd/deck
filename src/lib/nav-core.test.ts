import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, badgeText, isContained, isCurrent, isSessionPage, navLabel, showsNav, type NavId } from './nav-core';

function item(id: NavId) {
	const found = NAV_ITEMS.find((i) => i.id === id);
	if (!found) throw new Error(id);
	return found;
}

function current(pathname: string): NavId[] {
	return NAV_ITEMS.filter((i) => isCurrent(i, pathname)).map((i) => i.id);
}

describe('isCurrent', () => {
	it.each([
		['/', ['sessions']],
		['/s/c_abc', ['sessions']],
		['/inbox', ['inbox']],
		['/runs', ['runs']],
		['/runs/r_1', ['runs']],
		['/schedules', ['schedules']],
		['/projects', ['projects']],
		['/settings', ['settings']],
		['/runsheet', []],
		['/login', []]
	] as [string, NavId[]][])('%s marks %j', (path, ids) => {
		expect(current(path)).toEqual(ids);
	});

	it('gives settings its own page', () => {
		expect(item('settings').href).toBe('/settings');
		expect(isCurrent(item('settings'), '/projects')).toBe(false);
		expect(isCurrent(item('projects'), '/settings')).toBe(false);
	});
});

describe('where the nav shows', () => {
	it('leaves the sign-in pages bare', () => {
		expect(showsNav('/login')).toBe(false);
		expect(showsNav('/pair')).toBe(false);
		expect(showsNav('/')).toBe(true);
		expect(showsNav('/s/c_abc')).toBe(true);
	});

	it('knows the session page', () => {
		expect(isSessionPage('/s/c_abc')).toBe(true);
		expect(isSessionPage('/schedules')).toBe(false);
	});

	it('contains the list pages and not the session or run detail', () => {
		for (const p of ['/', '/inbox', '/runs', '/schedules', '/projects', '/settings']) expect(isContained(p)).toBe(true);
		expect(isContained('/s/c_abc')).toBe(false);
		expect(isContained('/runs/r_1')).toBe(false);
	});
});

describe('badge', () => {
	it.each([
		[0, ''],
		[-1, ''],
		[1, '1'],
		[9, '9'],
		[10, '9+']
	])('%i reads %j', (n, text) => {
		expect(badgeText(n)).toBe(text);
	});

	it('says how many wait in the inbox label only', () => {
		expect(navLabel(item('inbox'), 3)).toBe('Inbox, 3 waiting');
		expect(navLabel(item('inbox'), 0)).toBe('Inbox');
		expect(navLabel(item('runs'), 3)).toBe('Runs');
	});
});
