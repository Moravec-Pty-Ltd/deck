import { describe, expect, it } from 'vitest';
import { stopOutcome } from './stop-core';

describe('stopOutcome', () => {
	it('reports a live turn as interrupted, whatever the stored status says', () => {
		expect(stopOutcome(true, true)).toBe('interrupted');
		expect(stopOutcome(true, false)).toBe('interrupted');
	});

	it('flags a running status with no live turn behind it as not tracked', () => {
		expect(stopOutcome(false, true)).toBe('not-tracked');
	});

	it('reports an idle session as nothing running', () => {
		expect(stopOutcome(false, false)).toBe('nothing-running');
	});
});
