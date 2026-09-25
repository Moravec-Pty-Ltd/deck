import { describe, expect, it } from 'vitest';
import { buildRequest, parseReply, providerError, providerFor, type ModelMessage } from './operator-providers';

const messages: ModelMessage[] = [
	{ role: 'system', content: 'You are the operator.' },
	{ role: 'user', content: 'Stop the auth session.' },
	{
		role: 'assistant',
		content: 'Stopping it.',
		tool_calls: [{ id: 'c1', type: 'function', function: { name: 'stop_session', arguments: '{"session_id":"c_auth"}' } }]
	},
	{ role: 'tool', content: 'Stopped Auth.', tool_call_id: 'c1', name: 'stop_session' }
];

describe('providerFor', () => {
	it('takes the stated provider, else reads the host', () => {
		expect(providerFor({ provider: 'anthropic', url: 'http://127.0.0.1:17498/v1' })).toBe('anthropic');
		expect(providerFor({ provider: 'openai', url: 'https://api.anthropic.com/v1' })).toBe('openai');
		expect(providerFor({ url: 'https://api.anthropic.com/v1' })).toBe('anthropic');
		expect(providerFor({ url: 'http://strix-halo:8000/v1' })).toBe('openai');
		expect(providerFor({})).toBe('openai');
	});
});

describe('buildRequest', () => {
	it('speaks OpenAI chat completions with the tools and a bearer key', () => {
		const request = buildRequest('openai', { url: 'http://strix-halo:8000/v1/', model: 'qwen', apiKey: 'k' }, messages, true);
		expect(request.url).toBe('http://strix-halo:8000/v1/chat/completions');
		expect(request.headers.authorization).toBe('Bearer k');
		expect(request.body.messages).toHaveLength(4);
		expect((request.body.tools as unknown[]).length).toBeGreaterThan(0);
		expect(request.body.tool_choice).toBe('auto');
	});

	it('turns thinking off for a plain turn and keeps the key optional', () => {
		const request = buildRequest('openai', { url: 'http://127.0.0.1:17498/v1', model: 'qwen' }, messages, false);
		expect(request.body.chat_template_kwargs).toEqual({ enable_thinking: false });
		expect(request.body.tools).toBeUndefined();
		expect(request.headers.authorization).toBeUndefined();
	});

	it('speaks Anthropic messages: system apart, tool results paired by id, schemas renamed', () => {
		const request = buildRequest(
			'anthropic',
			{ url: 'https://api.anthropic.com/v1', model: 'claude-haiku-4-5-20251001', apiKey: 'sk-test' },
			messages,
			true
		);
		expect(request.url).toBe('https://api.anthropic.com/v1/messages');
		expect(request.headers['x-api-key']).toBe('sk-test');
		expect(request.headers['anthropic-version']).toBe('2023-06-01');
		expect(request.body.system).toBe('You are the operator.');
		const body = request.body.messages as Record<string, unknown>[];
		expect(body).toHaveLength(3);
		expect(body[1]).toEqual({
			role: 'assistant',
			content: [
				{ type: 'text', text: 'Stopping it.' },
				{ type: 'tool_use', id: 'c1', name: 'stop_session', input: { session_id: 'c_auth' } }
			]
		});
		expect(body[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'Stopped Auth.' }] });
		const tools = request.body.tools as { name: string; input_schema: unknown }[];
		expect(tools.map((t) => t.name)).toContain('stop_session');
		expect(tools[0].input_schema).toBeDefined();
	});

	it('never sends an empty assistant turn to Anthropic, which rejects one', () => {
		const request = buildRequest('anthropic', { url: 'https://api.anthropic.com/v1', model: 'm' }, [
			{ role: 'user', content: 'hi' },
			{ role: 'assistant', content: '' }
		], false);
		const body = request.body.messages as { content: string }[];
		expect(body[1].content).toBe('(no answer)');
	});
});

describe('parseReply', () => {
	it('reads an OpenAI reply', () => {
		const reply = parseReply('openai', {
			choices: [{ message: { content: ' Done. ', tool_calls: [{ id: 'x', type: 'function', function: { name: 'list_sessions', arguments: '{}' } }] } }]
		});
		expect(reply.content).toBe('Done.');
		expect(reply.toolCalls[0].function.name).toBe('list_sessions');
	});

	it('reads an Anthropic reply, joining text and collecting tool uses', () => {
		const reply = parseReply('anthropic', {
			content: [
				{ type: 'text', text: 'Stopping ' },
				{ type: 'text', text: 'it.' },
				{ type: 'tool_use', id: 'u1', name: 'stop_session', input: { session_id: 'c_auth' } }
			]
		});
		expect(reply.content).toBe('Stopping it.');
		expect(reply.toolCalls).toEqual([
			{ id: 'u1', type: 'function', function: { name: 'stop_session', arguments: '{"session_id":"c_auth"}' } }
		]);
	});

	it('survives an empty or odd reply', () => {
		expect(parseReply('openai', {})).toEqual({ content: '', toolCalls: [] });
		expect(parseReply('anthropic', {})).toEqual({ content: '', toolCalls: [] });
	});
});

describe('providerError', () => {
	it('explains the common refusals', () => {
		expect(providerError('anthropic', 401)).toContain('API key');
		expect(providerError('openai', 403)).toContain('credentials');
		expect(providerError('openai', 404)).toContain('not found');
		expect(providerError('openai', 429)).toContain('rate limited');
		expect(providerError('openai', 500)).toBe('the operator model replied 500');
	});
});
