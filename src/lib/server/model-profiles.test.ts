import { describe, expect, it, vi, beforeEach } from 'vitest';

const settings = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('./store', () => ({ readSettings: () => settings.value }));

const { findModelProfile, resolveModelArg } = await import('./model-profiles');

describe('model profiles', () => {
	beforeEach(() => {
		settings.value = {
			modelProfiles: [
				{ id: 'local', label: 'Local', model: 'qwen', env: { ANTHROPIC_BASE_URL: 'http://x/v1' } },
				{ id: 'bare', env: {} }
			]
		};
	});

	it('resolves a profile id to its own model for --model', () => {
		expect(resolveModelArg('local')).toBe('qwen');
		expect(findModelProfile('local')?.env.ANTHROPIC_BASE_URL).toBe('http://x/v1');
	});

	it('passes a normal claude shortname straight through', () => {
		expect(resolveModelArg('opus')).toBe('opus');
		expect(findModelProfile('opus')).toBeUndefined();
	});

	it('sends no --model for a profile without one, letting the backend choose', () => {
		expect(resolveModelArg('bare')).toBeUndefined();
		expect(findModelProfile('bare')).toBeDefined();
	});

	it('treats an unset model as no profile', () => {
		expect(findModelProfile(undefined)).toBeUndefined();
		expect(resolveModelArg(undefined)).toBeUndefined();
	});
});
