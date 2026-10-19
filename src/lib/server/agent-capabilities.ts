import { shippedSkillVersion } from './skills';

// What this server's agent API offers beyond the baseline, served by GET
// /api/agent so a client (the native apps, an orchestrator) can gate a feature
// on the server it is talking to instead of guessing from a version string.
// Append one token when a route lands; never rename or remove one a released
// client may check.
export const AGENT_CAPABILITIES: readonly string[] = [
	'stream',
	'history',
	'images',
	'files',
	'diff',
	'issue-sources',
	'servers',
	'speech',
	'operator',
	'reviews',
	'pr-dismiss',
	'zed',
	'quick-messages',
	'search',
	'user',
	'expensive-models',
];

export function agentInfo(): { version: string | null; capabilities: string[] } {
	return { version: shippedSkillVersion, capabilities: [...AGENT_CAPABILITIES] };
}
