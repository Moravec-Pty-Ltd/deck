import { describe, it, expect } from 'vitest';
import { parseViewMode, nextViewMode, viewModeLabel } from './view-mode';

describe('parseViewMode', () => {
	it('defaults to project when nothing is stored', () => {
		expect(parseViewMode(null, null)).toBe('project');
	});

	it('reads the shared key', () => {
		expect(parseViewMode('status', null)).toBe('status');
		expect(parseViewMode('project', null)).toBe('project');
	});

	it('migrates the sidebar key when the shared one is absent', () => {
		expect(parseViewMode(null, 'status')).toBe('status');
		expect(parseViewMode(null, 'project')).toBe('project');
	});

	it('prefers the shared key over the legacy one', () => {
		expect(parseViewMode('project', 'status')).toBe('project');
		expect(parseViewMode('status', 'project')).toBe('status');
	});

	it('falls back to project for an unrecognised value', () => {
		expect(parseViewMode('grouped', null)).toBe('project');
		expect(parseViewMode('', 'status')).toBe('status');
	});
});

describe('nextViewMode', () => {
	it('toggles between the two modes', () => {
		expect(nextViewMode('project')).toBe('status');
		expect(nextViewMode('status')).toBe('project');
	});
});

describe('viewModeLabel', () => {
	it('names the mode you would switch to', () => {
		expect(viewModeLabel('project')).toBe('Group by status');
		expect(viewModeLabel('status')).toBe('Group by project');
	});
});
