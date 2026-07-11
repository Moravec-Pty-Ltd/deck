import { describe, it, expect } from 'vitest';
import { agentFeed, publishAgentEvent, type AgentFeedEvent } from './agent-feed';

describe('publishAgentEvent', () => {
	it('emits { sessionId, type, at, ...payload } on the feed', () => {
		const seen: AgentFeedEvent[] = [];
		const on = (e: AgentFeedEvent) => seen.push(e);
		agentFeed.on('event', on);
		try {
			publishAgentEvent('c_1', 'status', { status: 'idle' });
			expect(seen).toHaveLength(1);
			expect(seen[0]).toMatchObject({ sessionId: 'c_1', type: 'status', status: 'idle' });
			expect(seen[0].at).toBeTypeOf('number');
		} finally {
			agentFeed.off('event', on);
		}
	});

	it('a throwing subscriber does not escape into the producer', () => {
		const boom = () => {
			throw new Error('subscriber bug');
		};
		agentFeed.on('event', boom);
		try {
			expect(() => publishAgentEvent('c_1', 'session-deleted')).not.toThrow();
		} finally {
			agentFeed.off('event', boom);
		}
	});
});
