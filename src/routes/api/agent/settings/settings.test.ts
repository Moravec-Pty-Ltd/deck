import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pinEnv } from '$lib/server/test-env';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-settings-'));
const restoreEnv = pinEnv({ DECK_DATA: tmpDir });
const { GET, PATCH } = await import('./+server');
const pairingRoute = await import('../pairing/+server');
const decideRoute = await import('../pairing/[id]/+server');
const { requestPairing } = await import('$lib/server/pairing');

afterAll(() => {
	restoreEnv();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

const SECRET = 'sk-route-secret-value';
const ENV_SECRET = 'env-route-secret-value';
const file = path.join(tmpDir, 'settings.json');

type Handler = (event: never) => Response | Promise<Response>;

function call(handler: Handler, init?: { body?: unknown; params?: Record<string, string> }): Promise<Response> {
	const request = new Request('http://localhost/api/agent/settings', {
		method: 'POST',
		body: init?.body === undefined ? undefined : JSON.stringify(init.body)
	});
	return Promise.resolve(handler({ request, params: init?.params ?? {} } as never));
}

async function status(run: () => Promise<Response>): Promise<number> {
	try {
		return (await run()).status;
	} catch (e) {
		return (e as { status: number }).status;
	}
}

beforeEach(() => {
	fs.writeFileSync(
		file,
		JSON.stringify({
			operator: { url: 'http://127.0.0.1:3001/v1', apiKey: SECRET },
			modelProfiles: [{ id: 'local', env: { TOKEN: ENV_SECRET } }],
			lastEffort: 'high'
		})
	);
});

describe('agent settings', () => {
	it('GET never returns a secret', async () => {
		const text = await (await call(GET)).text();
		expect(text).not.toContain(SECRET);
		expect(text).not.toContain(ENV_SECRET);
		expect(JSON.parse(text).operator.hasApiKey).toBe(true);
		expect(JSON.parse(text).modelProfiles[0].envKeys).toEqual(['TOKEN']);
	});

	it('PATCH merges on the server and keeps the key when omitted', async () => {
		const res = await call(PATCH, { body: { operator: { model: 'm' }, autoCompact: { enabled: true, percent: 99 }, zedSshTarget: 'user@example' } });
		const text = await res.text();
		expect(text).not.toContain(SECRET);
		expect(text).not.toContain(ENV_SECRET);
		const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
		expect(saved.operator).toEqual({ url: 'http://127.0.0.1:3001/v1', apiKey: SECRET, model: 'm' });
		expect(saved.modelProfiles[0].env.TOKEN).toBe(ENV_SECRET);
		expect(saved.lastEffort).toBe('high');
		expect(saved.autoCompact).toEqual({ enabled: true, percent: 95 });
		expect(saved.zedSshTarget).toBe('user@example');
	});

	it('PATCH null clears the key', async () => {
		const body = await (await call(PATCH, { body: { operator: { apiKey: null } } })).json();
		expect(body.operator.hasApiKey).toBe(false);
		expect(JSON.parse(fs.readFileSync(file, 'utf8')).operator.apiKey).toBeUndefined();
	});

	it('PATCH rejects an unknown block without writing', async () => {
		const before = fs.readFileSync(file, 'utf8');
		expect(await status(() => call(PATCH, { body: { modelProfiles: [] } }))).toBe(400);
		expect(await status(() => call(PATCH, { body: [] }))).toBe(400);
		expect(fs.readFileSync(file, 'utf8')).toBe(before);
	});
});

describe('agent pairing', () => {
	it('lists a pending request without its secret, then decides it', async () => {
		const req = requestPairing();
		const { pending } = await (await call(pairingRoute.GET)).json();
		expect(JSON.stringify(pending)).not.toContain(req.secret);
		const row = pending.find((p: { code: string }) => p.code === req.code);
		expect(row).toBeDefined();
		const decided = await call(decideRoute.POST, { body: { approve: true }, params: { id: row.id } });
		expect(await decided.json()).toEqual({ ok: true });
		const again = await call(decideRoute.POST, { body: { approve: false }, params: { id: row.id } });
		expect(await again.json()).toEqual({ ok: false });
	});

	it('400s without a boolean approve', async () => {
		expect(await status(() => call(decideRoute.POST, { body: { approve: 'yes' }, params: { id: 'x' } }))).toBe(400);
	});
});
