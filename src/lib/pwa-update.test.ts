import { describe, it, expect } from 'vitest';
import { isUpdateReady } from './pwa-update';

describe('isUpdateReady', () => {
	it('prompts when a new worker finished installing over an existing controller', () => {
		expect(isUpdateReady('installed', true)).toBe(true);
	});

	it('stays quiet on the first install (no prior controller)', () => {
		expect(isUpdateReady('installed', false)).toBe(false);
	});

	it('stays quiet while the new worker is still installing or already active', () => {
		expect(isUpdateReady('installing', true)).toBe(false);
		expect(isUpdateReady('activating', true)).toBe(false);
		expect(isUpdateReady('activated', true)).toBe(false);
		expect(isUpdateReady('redundant', true)).toBe(false);
	});
});
