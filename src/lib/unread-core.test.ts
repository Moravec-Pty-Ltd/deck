import { describe, it, expect } from 'vitest';
import { unreadCount } from './unread-core';

describe('unreadCount', () => {
	it('counts unread sessions that are not hidden', () => {
		expect(
			unreadCount([{ unread: true }, { unread: true, hidden: true }, {}, { unread: false }, { unread: true }])
		).toBe(2);
	});

	it('is zero for an empty list', () => {
		expect(unreadCount([])).toBe(0);
	});
});
