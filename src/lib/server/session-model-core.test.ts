import { describe, expect, it } from 'vitest';
import { parseModel } from './session-model-core';

describe('parseModel', () => {
	it('treats an absent model as a reset', () => {
		expect(parseModel(undefined)).toEqual({ ok: true, model: undefined });
	});

	it('treats an empty or whitespace-only model as a reset', () => {
		expect(parseModel('')).toEqual({ ok: true, model: undefined });
		expect(parseModel('   ')).toEqual({ ok: true, model: undefined });
	});

	it('trims and keeps a valid model string', () => {
		expect(parseModel('  claude-fable-5  ')).toEqual({ ok: true, model: 'claude-fable-5' });
	});

	it('rejects a non-string model', () => {
		expect(parseModel(42)).toEqual({ ok: false });
		expect(parseModel(null)).toEqual({ ok: false });
		expect(parseModel({ model: 'x' })).toEqual({ ok: false });
	});

	it('rejects a model that would be read as a CLI flag', () => {
		expect(parseModel('--dangerous')).toEqual({ ok: false });
		expect(parseModel('-x')).toEqual({ ok: false });
	});
});
