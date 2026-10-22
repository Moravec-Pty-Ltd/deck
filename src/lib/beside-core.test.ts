import { describe, expect, it } from 'vitest';
import { resolveBeside } from './beside-core';

const sessions = [{ id: 'a' }, { id: 'b' }];

describe('resolveBeside', () => {
	it('returns the live session', () => expect(resolveBeside('b', 'a', sessions)).toBe(sessions[1]));
	it('rejects the current session', () => expect(resolveBeside('a', 'a', sessions)).toBeNull());
	it('rejects unknown and missing ids', () => {
		expect(resolveBeside('x', 'a', sessions)).toBeNull();
		expect(resolveBeside(null, 'a', sessions)).toBeNull();
	});
});
