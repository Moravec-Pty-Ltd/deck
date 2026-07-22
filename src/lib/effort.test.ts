import { describe, expect, it } from 'vitest';
import { effortLabel, resolveEffort } from './effort';
import type { DeckSettings, Project } from '$lib/types';

const project = (lastEffort?: Project['lastEffort']): Project => ({
	name: 'p',
	path: '/p',
	lastEffort
});

describe('resolveEffort', () => {
	it("prefers the project's last pick", () => {
		expect(resolveEffort(project('high'), { lastEffort: 'low' })).toBe('high');
	});

	it('falls back to the global last-used when the project has none', () => {
		expect(resolveEffort(project(undefined), { lastEffort: 'max' })).toBe('max');
	});

	it('falls back to the global last-used when there is no project', () => {
		expect(resolveEffort(undefined, { lastEffort: 'medium' })).toBe('medium');
	});

	it('is undefined (CLI default) when nothing is remembered', () => {
		expect(resolveEffort(project(undefined), {} as DeckSettings)).toBeUndefined();
		expect(resolveEffort(undefined, {})).toBeUndefined();
	});
});

describe('effortLabel', () => {
	it('names a set effort', () => {
		expect(effortLabel('high')).toBe('high');
	});

	it('labels an unset effort as the default', () => {
		expect(effortLabel(undefined)).toBe('default');
		expect(effortLabel('')).toBe('default');
	});
});
