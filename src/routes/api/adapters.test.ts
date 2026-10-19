import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { pinEnv } from '$lib/server/test-env';

// Every browser route under /api/sessions/[id] that has an agent API twin must
// export the very same handler function, so the two surfaces cannot drift. Add
// a row when a shared route lands.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-adapters-'));
const restoreEnv = pinEnv({ DECK_DATA: tmpDir });

afterAll(() => {
	restoreEnv();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

type Route = Record<string, unknown>;

// [browser route, agent route, methods]
const SHARED: [() => Promise<Route>, () => Promise<Route>, string[]][] = [
	[() => import('./sessions/[id]/events/+server'), () => import('./agent/sessions/[id]/stream/+server'), ['GET']],
	[() => import('./sessions/[id]/transcript/+server'), () => import('./agent/sessions/[id]/history/+server'), ['GET']],
	[() => import('./sessions/[id]/images/[file]/+server'), () => import('./agent/sessions/[id]/images/[file]/+server'), ['GET']],
	[() => import('./sessions/[id]/files/+server'), () => import('./agent/sessions/[id]/files/+server'), ['GET', 'POST']],
	[() => import('./sessions/[id]/diff/+server'), () => import('./agent/sessions/[id]/diff/+server'), ['GET']],
	[() => import('./sessions/[id]/model/+server'), () => import('./agent/sessions/[id]/model/+server'), ['POST']],
	[() => import('./sessions/[id]/restart/+server'), () => import('./agent/sessions/[id]/restart/+server'), ['POST']]
];

describe('browser and agent routes share one handler', () => {
	it.each(SHARED)('%#', async (browserRoute, agentRoute, methods) => {
		const [browser, agent] = await Promise.all([browserRoute(), agentRoute()]);
		for (const method of methods) {
			expect(typeof browser[method]).toBe('function');
			expect(agent[method]).toBe(browser[method]);
		}
	});
});
