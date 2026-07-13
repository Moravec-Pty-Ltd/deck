import { describe, it, expect } from 'vitest';
import { classifyAnswerFailure } from './agent-answer-core';

describe('classifyAnswerFailure', () => {
	it('reports no-pending-ask when nothing is waiting', () => {
		expect(
			classifyAnswerFailure({ mcpPending: false, wfPending: false, providedAskId: '', wfAskId: null })
		).toBe('no-pending-ask');
	});

	it('reports askid-required when a workflow checkpoint waits but no askId was sent', () => {
		expect(
			classifyAnswerFailure({ mcpPending: false, wfPending: true, providedAskId: '', wfAskId: 'wfask-1' })
		).toBe('askid-required');
	});

	it('reports askid-mismatch when the askId aims at a different checkpoint', () => {
		expect(
			classifyAnswerFailure({ mcpPending: false, wfPending: true, providedAskId: 'wfask-old', wfAskId: 'wfask-1' })
		).toBe('askid-mismatch');
	});

	it('treats a still-pending MCP ask as no-pending-ask (it would have resolved by text)', () => {
		expect(
			classifyAnswerFailure({ mcpPending: true, wfPending: true, providedAskId: '', wfAskId: 'wfask-1' })
		).toBe('no-pending-ask');
	});
});
