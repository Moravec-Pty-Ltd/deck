import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeckSession } from '$lib/types';

const mocks = vi.hoisted(() => ({ send: vi.fn(), update: vi.fn(), append: vi.fn(), context: vi.fn(), session: vi.fn() }));
vi.mock('./agents/dispatch', () => ({ agentSend: mocks.send, agentInterrupt: vi.fn() }));
vi.mock('./store', () => ({ updateSession: mocks.update }));
vi.mock('./claude', () => ({ appendEvent: mocks.append }));
vi.mock('./issues/prompt', () => ({ issuePromptContext: mocks.context }));
vi.mock('./sessions', () => ({ getSession: mocks.session }));
vi.mock('./http', () => ({ agentSessionOr404: mocks.session, objectBody: (request: Request) => request.json() }));
vi.mock('./tmux', () => ({ sendKeys: vi.fn(), sendRawKey: vi.fn() }));
vi.mock('./event-log', () => ({ currentLogSeq: () => 42 }));
const { POST: web } = await import('../../routes/api/sessions/[id]/send/+server');
const { POST: agent } = await import('../../routes/api/agent/sessions/[id]/message/+server');

beforeEach(() => {
	vi.resetAllMocks();
	mocks.session.mockResolvedValue({ id: 'example', kind: 'claude', cwd: '/path/to/project', title: 'Fix', issues: [{ source: 'linear', sourceId: 'source-a', id: 'EX-1', url: '' }] } as DeckSession);
	mocks.send.mockResolvedValue(undefined);
	mocks.context.mockResolvedValue({ issueBody: 'Details', issueComments: 'Discussion' });
});

for (const [name, route] of [['web', web], ['agent', agent]] as const) {
	describe(`${name} message contract`, () => {
		function send(body: Record<string, unknown>) {
			return route({ params: { id: 'example' }, request: new Request('http://example.test/send', { method: 'POST', body: JSON.stringify(body) }) } as Parameters<typeof web>[0] & Parameters<typeof agent>[0]);
		}
		it('preserves literal placeholders with images', async () => {
			const images = [{ media_type: 'image/png', data: 'aGVsbG8=' }];
			await send({ text: '[issue_body]', images });
			expect(mocks.send).toHaveBeenCalledWith(expect.anything(), '[issue_body]', images, undefined);
			expect(mocks.context).not.toHaveBeenCalled();
		});
		it('enriches quick-message templates through shared issue context', async () => {
			await send({ text: '[title]: [issue_body] / [issue_comments]', expand: true });
			expect(mocks.send).toHaveBeenCalledWith(expect.anything(), 'Fix: Details / Discussion', undefined, undefined);
			expect(mocks.context).toHaveBeenCalledWith('/path/to/project', [expect.objectContaining({ sourceId: 'source-a' })]);
		});
		it('rejects a prompt that becomes empty', async () => {
			await expect(send({ text: '[pr_title]', expand: true })).rejects.toMatchObject({ status: 400 });
			expect(mocks.send).not.toHaveBeenCalled();
		});
		it('rejects invalid text types', async () => {
			await expect(send({ text: {} })).rejects.toMatchObject({ status: 400 });
		});
		it('records a failed background dispatch', async () => {
			mocks.send.mockRejectedValue(new Error('agent unavailable'));
			await send({ text: 'hello' });
			await Promise.resolve();
			expect(mocks.append).toHaveBeenCalledWith('example', expect.objectContaining({ type: 'deck.error', text: 'agent unavailable' }));
		});
		it('rejects images for text-only runtimes', async () => {
			mocks.session.mockResolvedValue({ id: 'example', kind: 'codex' });
			await expect(send({ text: 'inspect', images: [{ media_type: 'image/png', data: 'aGVsbG8=' }] })).rejects.toMatchObject({ status: 400 });
			expect(mocks.send).not.toHaveBeenCalled();
		});
	});
}
