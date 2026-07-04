import { describe, expect, it } from 'vitest';
import { shouldReseedModel } from './models';

describe('shouldReseedModel', () => {
	it('re-seeds when the agent kind changes', () => {
		expect(
			shouldReseedModel(
				{ kind: 'claude', projectPath: '/a' },
				{ kind: 'pi', projectPath: '/a' }
			)
		).toBe(true);
	});

	it('re-seeds on first mount (no kind seeded yet)', () => {
		expect(
			shouldReseedModel({ kind: null, projectPath: undefined }, { kind: 'claude', projectPath: undefined })
		).toBe(true);
	});

	it('re-seeds when switching between two defined projects', () => {
		expect(
			shouldReseedModel({ kind: 'claude', projectPath: '/a' }, { kind: 'claude', projectPath: '/b' })
		).toBe(true);
	});

	it('does not re-seed on the initial undefined -> project hydration', () => {
		// The projects list lands after the modal opens; a model typed before it
		// arrives must survive the settle.
		expect(
			shouldReseedModel(
				{ kind: 'claude', projectPath: undefined },
				{ kind: 'claude', projectPath: '/a' }
			)
		).toBe(false);
	});

	it('does not re-seed for the same kind and project', () => {
		expect(
			shouldReseedModel({ kind: 'claude', projectPath: '/a' }, { kind: 'claude', projectPath: '/a' })
		).toBe(false);
	});

	it('does not re-seed when the project becomes undefined (e.g. a custom path)', () => {
		expect(
			shouldReseedModel(
				{ kind: 'claude', projectPath: '/a' },
				{ kind: 'claude', projectPath: undefined }
			)
		).toBe(false);
	});
});
