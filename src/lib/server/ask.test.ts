import { describe, expect, it, vi } from 'vitest';

vi.mock('./store', () => ({ getStoredSession: () => ({ title: 'Example' }) }));
vi.mock('./push', () => ({ notify: vi.fn() }));
vi.mock('./apns', () => ({ apnsWidgetsChanged: vi.fn() }));
vi.mock('./agent-feed', () => ({ publishAgentEvent: vi.fn() }));
vi.mock('./transcript', () => ({ latestAskToolUseId: async () => 'toolu_1' }));
const { registerAsk, resolveAsk, wasSettled, pendingAskId } = await import('./ask');
const { apnsWidgetsChanged } = await import('./apns');

describe('settled asks', () => {
	it('remembers an answered ask and reloads the widget', async () => {
		const answered = registerAsk('s_settle', [{ question: 'Which?', options: [] }]);
		await vi.waitFor(() => expect(pendingAskId('s_settle')).toBe('toolu_1'));
		expect(wasSettled('s_settle', 'toolu_1')).toBe(false);
		expect(resolveAsk('s_settle', 'Blue')).toBe(true);
		await expect(answered).resolves.toBe('Blue');
		expect(wasSettled('s_settle', 'toolu_1')).toBe(true);
		expect(wasSettled('s_other', 'toolu_1')).toBe(false);
		expect(apnsWidgetsChanged).toHaveBeenCalled();
	});
});
