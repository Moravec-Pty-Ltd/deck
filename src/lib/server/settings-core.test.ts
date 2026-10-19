import { describe, expect, it } from 'vitest';
import type { DeckSettings } from '$lib/types';
import { mergeSettings, parseSettingsPatch, redactSettings, type SettingsPatch } from './settings-core';

const SECRET = 'sk-test-secret-value';
const ENV_SECRET = 'env-secret-value';

const stored: DeckSettings = {
	speech: { ttsUrl: 'http://127.0.0.1:3000', voice: 'v1' },
	operator: { url: 'http://127.0.0.1:3001/v1', model: 'm', provider: 'openai', apiKey: SECRET },
	modelProfiles: [{ id: 'local', label: 'Local', model: 'x', env: { ANTHROPIC_AUTH_TOKEN: ENV_SECRET, BASE: ENV_SECRET } }],
	lastEffort: 'high',
	zedSshTarget: 'user@example',
	autoCompact: { enabled: true, percent: 120 }
};

function patchOf(body: Record<string, unknown>): SettingsPatch {
	const parsed = parseSettingsPatch(body);
	if (!parsed.ok) throw new Error(parsed.message);
	return parsed.patch;
}

describe('redactSettings', () => {
	it('carries no secret value', () => {
		const view = redactSettings(stored);
		const text = JSON.stringify(view);
		expect(text).not.toContain(SECRET);
		expect(text).not.toContain(ENV_SECRET);
		expect(view.operator).toEqual({ url: 'http://127.0.0.1:3001/v1', model: 'm', provider: 'openai', hasApiKey: true });
		expect(view.modelProfiles).toEqual([{ id: 'local', label: 'Local', model: 'x', envKeys: ['ANTHROPIC_AUTH_TOKEN', 'BASE'] }]);
		expect(view.autoCompact).toEqual({ enabled: true, percent: 95 });
	});

	it('reports a missing key and leaves unset blocks out', () => {
		expect(redactSettings({ operator: { url: 'u' } })).toEqual({ operator: { url: 'u', hasApiKey: false } });
		expect(redactSettings({})).toEqual({});
	});

	it('drops keys it does not know', () => {
		const view = redactSettings({ ...stored, futureSecret: SECRET } as DeckSettings);
		expect(JSON.stringify(view)).not.toContain(SECRET);
	});
});

describe('parseSettingsPatch', () => {
	it.each([
		[{ modelProfiles: [] }, 'unknown setting modelProfiles'],
		[{ speech: 'x' }, 'speech must be an object or null'],
		[{ speech: { nope: 'x' } }, 'unknown field speech.nope'],
		[{ operator: { provider: 'other' } }, 'invalid operator.provider'],
		[{ operator: { apiKey: 5 } }, 'invalid operator.apiKey'],
		[{ autoCompact: { enabled: 'yes' } }, 'invalid autoCompact.enabled'],
		[{ autoCompact: { percent: Number.NaN } }, 'invalid autoCompact.percent'],
		[{ zedSshTarget: 3 }, 'invalid zedSshTarget']
	])('rejects %j', (body, message) => {
		expect(parseSettingsPatch(body)).toEqual({ ok: false, message });
	});

	it('reads blank strings as clears', () => {
		expect(patchOf({ speech: { voice: '  ' }, zedSshTarget: '' })).toEqual({ blocks: { speech: { voice: null } }, zedSshTarget: null });
	});
});

describe('mergeSettings', () => {
	it('keeps the api key when the patch omits it', () => {
		const next = mergeSettings(stored, patchOf({ operator: { model: 'n' } }));
		expect(next.operator).toEqual({ ...stored.operator, model: 'n' });
		expect(next.modelProfiles).toBe(stored.modelProfiles);
	});

	it('clears a field on null and a block on null', () => {
		const next = mergeSettings(stored, patchOf({ operator: { apiKey: null }, speech: null, zedSshTarget: null }));
		expect(next.operator?.apiKey).toBeUndefined();
		expect(next.operator?.url).toBe(stored.operator?.url);
		expect('speech' in next).toBe(false);
		expect('zedSshTarget' in next).toBe(false);
	});

	it('removes a block emptied field by field', () => {
		const next = mergeSettings({ speech: { voice: 'v' } }, patchOf({ speech: { voice: null } }));
		expect('speech' in next).toBe(false);
	});

	it('clamps the compact percent', () => {
		expect(mergeSettings({}, patchOf({ autoCompact: { enabled: true, percent: 10 } })).autoCompact).toEqual({ enabled: true, percent: 50 });
		expect(mergeSettings({}, patchOf({ autoCompact: { enabled: false } })).autoCompact).toEqual({ enabled: false });
	});

	it('drops the stored key and key file when the url moves to another origin', () => {
		const current: DeckSettings = { operator: { ...stored.operator, apiKeyFile: '~/.secrets/model-key' } };
		const next = mergeSettings(current, patchOf({ operator: { url: 'https://attacker.example/v1' } }));
		expect(next.operator).toEqual({ url: 'https://attacker.example/v1', model: 'm', provider: 'openai' });
	});

	it.each([
		['another port', 'http://127.0.0.1:3002/v1'],
		['another scheme', 'https://127.0.0.1:3001/v1'],
		['an unparseable url', 'not a url']
	])('treats %s as another origin', (_label, url) => {
		expect(mergeSettings(stored, patchOf({ operator: { url } })).operator?.apiKey).toBeUndefined();
	});

	it('keeps the key when the url stays on the same origin', () => {
		const next = mergeSettings(stored, patchOf({ operator: { url: 'http://127.0.0.1:3001/v2' } }));
		expect(next.operator?.apiKey).toBe(SECRET);
	});

	it('keeps a key or key file the same patch supplies', () => {
		const current: DeckSettings = { operator: { url: 'http://127.0.0.1:3001/v1', apiKey: SECRET, apiKeyFile: '~/.secrets/a' } };
		const next = mergeSettings(current, patchOf({ operator: { url: 'https://other.example/v1', apiKey: 'new', apiKeyFile: '~/.secrets/b' } }));
		expect(next.operator).toEqual({ url: 'https://other.example/v1', apiKey: 'new', apiKeyFile: '~/.secrets/b' });
		const keyOnly = mergeSettings(current, patchOf({ operator: { url: 'https://other.example/v1', apiKey: 'new' } }));
		expect(keyOnly.operator).toEqual({ url: 'https://other.example/v1', apiKey: 'new' });
	});

	it('drops the stored key when a url is set where none was stored', () => {
		const next = mergeSettings({ operator: { apiKey: SECRET } }, patchOf({ operator: { url: 'https://other.example/v1' } }));
		expect(next.operator).toEqual({ url: 'https://other.example/v1' });
	});

	it('leaves the input untouched', () => {
		const before = JSON.stringify(stored);
		mergeSettings(stored, patchOf({ operator: { apiKey: 'new' }, speech: null }));
		expect(JSON.stringify(stored)).toBe(before);
	});
});
