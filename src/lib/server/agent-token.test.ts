import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { agentMayReach, agentToken, agentTokenSession, childEnv } from './agent-token';

describe('agent tokens', () => {
	it('names its session, and only with the right secret', () => {
		const token = agentToken('secret', 'c_abc');
		expect(agentTokenSession('secret', token)).toBe('c_abc');
		expect(agentTokenSession('other', token)).toBeNull();
		expect(agentTokenSession('secret', token.replace('c_abc', 'c_abd'))).toBeNull();
		expect(agentTokenSession('secret', 'secret')).toBeNull();
		expect(agentTokenSession('secret', null)).toBeNull();
	});

	it('reaches the agent API, minus settings, credentials, accounts, pairing and project config', () => {
		for (const p of ['/api/agent', '/api/agent/sessions', '/api/agent/runs/[id]/[action]', '/api/agent/sessions/[id]']) {
			expect(agentMayReach(p, 'POST'), p).toBe(true);
		}
		for (const p of [
			null, '/api/token', '/api/sessions', '/api/agent/settings', '/api/agent/settings/skill', '/api/agent/credentials',
			'/api/agent/accounts', '/api/agent/pairing/[id]', '/api/agent/user', '/api/agent/projects/config', '/api/agent/projects/remote/secret'
		]) {
			expect(agentMayReach(p, 'GET'), String(p)).toBe(false);
		}
	});

	it('denies routes that exist, so a rename cannot leave the rule stale', () => {
		for (const dir of ['settings', 'credentials', 'accounts', 'pairing', 'user', 'projects/config', 'projects/sources', 'projects/remote', 'projects/clone']) {
			expect(fs.existsSync(`src/routes/api/agent/${dir}`), dir).toBe(true);
		}
	});

	it('reads the project list but registers nothing', () => {
		expect(agentMayReach('/api/agent/projects', 'GET')).toBe(true);
		expect(agentMayReach('/api/agent/projects', 'POST')).toBe(false);
		expect(agentMayReach('/api/agent/projects/clone', 'POST')).toBe(false);
	});

	it("keeps deck's own settings out of a child's environment, and the user's other variables in", () => {
		expect(childEnv({ PATH: '/bin', DECK_TOKEN: 't', DECK_DATA: '/d', DECK_NOTIFY_SCRIPT: '/n', NTFY_TOPIC: 'x' })).toEqual({
			PATH: '/bin', DECK_NOTIFY_SCRIPT: '/n', NTFY_TOPIC: 'x'
		});
	});
});
