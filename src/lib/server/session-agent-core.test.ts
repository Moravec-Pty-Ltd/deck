import { describe, expect, it } from 'vitest';
import { agentSwitchPatch, handoffContext, handoffPrompt, parseAgent } from './session-agent-core';

describe('agent handoff', () => {
	it('only accepts agent runtimes', () => {
		expect(parseAgent('codex')).toBe('codex');
		for (const value of ['shell', '--flag', null, {}, 1]) expect(parseAgent(value)).toBeNull();
	});
	it('clears incompatible native handles and model settings', () => {
		const previous = { kind: 'claude', model: 'opus', effort: 'high', provider: 'example', claudeSessionId: 'old', agentSessionId: 'old' };
		const next = { ...previous, ...agentSwitchPatch('codex', 'fresh', 'context') };
		expect(next).toMatchObject({ kind: 'codex', agentRuntimeId: 'fresh', pendingHandoff: 'context', status: 'idle' });
		for (const key of ['model', 'effort', 'provider', 'claudeSessionId', 'agentSessionId'] as const) expect(next[key]).toBeUndefined();
	});
	it('bounds history while preserving the current request separately', () => {
		const context = handoffContext([{ role: 'user', text: 'x'.repeat(30000) }, { role: 'assistant', text: 'latest answer' }]);
		expect(context.length).toBeLessThan(25000);
		expect(context).toContain('assistant: latest answer');
		expect(handoffPrompt(context, 'next task')).toContain('</previous_conversation>\n\nCurrent user request:\nnext task');
		expect(handoffPrompt(undefined, 'unchanged')).toBe('unchanged');
	});
});
