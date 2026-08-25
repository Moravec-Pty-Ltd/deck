import { describe, expect, it } from 'vitest';
import { CLAUDE_MODELS, claudeModelOptions, isExpensiveModel, shouldReseedModel } from './models';

describe('isExpensiveModel', () => {
	it('flags the seeded expensive models by name', () => {
		expect(isExpensiveModel('fable')).toBe(true);
		expect(isExpensiveModel('sol')).toBe(true);
	});

	it('is case-insensitive', () => {
		expect(isExpensiveModel('FABLE')).toBe(true);
		expect(isExpensiveModel('Sol')).toBe(true);
	});

	it('matches a substring inside a free-text / provider-model id', () => {
		expect(isExpensiveModel('anthropic/claude-sol-1')).toBe(true);
		expect(isExpensiveModel('fable-preview')).toBe(true);
	});

	it('matches an expensive provider when model is separate (pi)', () => {
		expect(isExpensiveModel('', 'sol')).toBe(true);
	});

	it('does not flag the standard models', () => {
		expect(isExpensiveModel('opus')).toBe(false);
		expect(isExpensiveModel('sonnet')).toBe(false);
		expect(isExpensiveModel('haiku')).toBe(false);
		expect(isExpensiveModel('anthropic/claude-sonnet-4-5', 'anthropic')).toBe(false);
	});

	it('does not flag an empty / unset model', () => {
		expect(isExpensiveModel('')).toBe(false);
		expect(isExpensiveModel(undefined)).toBe(false);
	});
});

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

describe('claudeModelOptions', () => {
	it('offers the built-in shortnames when no profiles are configured', () => {
		expect(claudeModelOptions({}).map((o) => o.value)).toEqual([...CLAUDE_MODELS]);
	});

	it('appends locally configured profiles, labelled', () => {
		const opts = claudeModelOptions({
			modelProfiles: [{ id: 'local', label: 'Local (strix)', env: { A: '1' } }]
		});
		expect(opts.at(-1)).toEqual({ value: 'local', label: 'Local (strix)' });
		// The built-ins are still first so the default pick is unchanged.
		expect(opts[0].value).toBe(CLAUDE_MODELS[0]);
	});

	it('falls back to the id when a profile has no label', () => {
		const opts = claudeModelOptions({ modelProfiles: [{ id: 'bare', env: {} }] });
		expect(opts.at(-1)).toEqual({ value: 'bare', label: 'bare' });
	});
});
