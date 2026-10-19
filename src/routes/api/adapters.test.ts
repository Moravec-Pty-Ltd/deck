import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { pinEnv } from '$lib/server/test-env';

// Every browser route that has an agent API twin must
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
	[() => import('./servers/+server'), () => import('./agent/servers/+server'), ['GET']],
	[() => import('./sessions/[id]/servers/+server'), () => import('./agent/sessions/[id]/servers/+server'), ['GET']],
	[() => import('./sessions/[id]/servers/[name]/+server'), () => import('./agent/sessions/[id]/servers/[name]/+server'), ['POST']],
	[() => import('./sessions/[id]/servers/[name]/logs/+server'), () => import('./agent/sessions/[id]/servers/[name]/logs/+server'), ['GET']],
	[() => import('./speech/+server'), () => import('./agent/speech/+server'), ['GET']],
	[() => import('./speech/segments/+server'), () => import('./agent/speech/segments/+server'), ['POST']],
	[() => import('./speech/audio/[id]/+server'), () => import('./agent/speech/audio/[id]/+server'), ['GET']],
	[() => import('./speech/transcribe/+server'), () => import('./agent/speech/transcribe/+server'), ['POST']],
	[() => import('./operator/+server'), () => import('./agent/operator/+server'), ['GET', 'POST']],
	[() => import('./operator/events/+server'), () => import('./agent/operator/events/+server'), ['GET']],
	[() => import('./operator/history/+server'), () => import('./agent/operator/history/+server'), ['GET']],
	[() => import('./operator/reset/+server'), () => import('./agent/operator/reset/+server'), ['POST']],
	[() => import('./reviews/+server'), () => import('./agent/reviews/+server'), ['GET']],
	[() => import('./sessions/[id]/pr/+server'), () => import('./agent/sessions/[id]/pr/+server'), ['DELETE']],
	[() => import('./quick-messages/+server'), () => import('./agent/quick-messages/+server'), ['GET', 'PUT']],
	[() => import('./search/+server'), () => import('./agent/search/+server'), ['GET']],
	[() => import('./user/+server'), () => import('./agent/user/+server'), ['GET']],
	[() => import('./projects/+server'), () => import('./agent/projects/+server'), ['POST', 'DELETE']],
	[() => import('./git/branches/+server'), () => import('./agent/git/branches/+server'), ['GET']],
	[() => import('./git/worktrees/+server'), () => import('./agent/git/worktrees/+server'), ['GET']]
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
