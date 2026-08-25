import { describe, expect, it } from 'vitest';
import { forKind, fromRow, toRow } from './automation-form-core';

describe('automation lane form mapping', () => {
	it('shows an unconfigured lane as claude with nothing picked', () => {
		expect(toRow(undefined)).toEqual({ kind: 'claude', model: '', provider: '', effort: undefined });
	});

	it('round-trips a configured lane', () => {
		const agent = { kind: 'pi' as const, model: 'qwen', provider: 'local', effort: undefined };
		expect(fromRow(toRow(agent))).toEqual(agent);
	});

	it('sends an empty object for an untouched lane, so the server clears rather than carries', () => {
		// JSON.stringify drops undefined-valued keys, so returning undefined here
		// would take the key off the wire entirely and the server would read that as
		// "a stale client didn't mention it" and keep the old pick.
		expect(fromRow(toRow(undefined))).toEqual({});
		expect(JSON.stringify({ reviewAgent: fromRow(toRow(undefined)) })).toBe('{"reviewAgent":{}}');
	});

	it('clears a previously-configured lane once it is set back to the default', () => {
		const row = toRow({ kind: 'pi', model: 'qwen', provider: 'local' });
		expect(fromRow(forKind(row, 'claude'))).toEqual({});
	});

	it('treats a whitespace-only model or provider as unset', () => {
		expect(fromRow({ kind: 'claude', model: '  ', provider: '', effort: undefined })).toEqual({});
		expect(fromRow({ kind: 'pi', model: ' qwen ', provider: '  ', effort: undefined })).toEqual({
			kind: 'pi',
			model: 'qwen',
			provider: undefined,
			effort: undefined
		});
	});

	it('keeps a lane that names only a non-default kind', () => {
		expect(fromRow({ kind: 'codex', model: '', provider: '', effort: undefined })).toMatchObject({ kind: 'codex' });
	});

	it('drops the fields a newly-picked kind has no use for', () => {
		const claude = { kind: 'claude' as const, model: 'opus', provider: '', effort: 'high' as const };
		expect(forKind(claude, 'pi')).toEqual({ kind: 'pi', model: '', provider: '', effort: undefined });
		const pi = { kind: 'pi' as const, model: 'qwen', provider: 'local', effort: undefined };
		expect(forKind(pi, 'codex')).toEqual({ kind: 'codex', model: '', provider: '', effort: undefined });
		// Switching between two claude models keeps the effort, which still applies.
		expect(forKind(claude, 'claude').effort).toBe('high');
	});
});
