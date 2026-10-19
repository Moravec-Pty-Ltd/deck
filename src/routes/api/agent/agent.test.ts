import { expect, it } from 'vitest';
import { GET } from './+server';
import { AGENT_CAPABILITIES } from '$lib/server/agent-capabilities';
import { shippedSkillVersion } from '$lib/server/skills';

it('reports the contract version and every capability token', async () => {
	const res = await GET({} as Parameters<typeof GET>[0]);
	const body = await res.json();
	expect(body).toEqual({ version: shippedSkillVersion, capabilities: [...AGENT_CAPABILITIES] });
	expect(body.capabilities).toEqual(expect.arrayContaining(['stream', 'history', 'images', 'files', 'diff']));
	expect(body.capabilities).toEqual(expect.arrayContaining(['servers', 'speech', 'operator', 'reviews']));
	expect(new Set(body.capabilities).size).toBe(body.capabilities.length);
});
