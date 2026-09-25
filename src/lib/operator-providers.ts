// Talking to whichever model the operator is pointed at. Two shapes are
// spoken: OpenAI chat completions (mlx_lm.server, llama-server, vLLM on the
// tailnet, and most hosted models) and Anthropic messages (Claude). Both are
// mapped to and from the one internal shape the operator works in, so the
// rest of the code never knows which is in use. Pure: the caller does the
// fetching.

import { OPERATOR_TOOLS, type ToolCall } from './operator-core';

export type OperatorProvider = 'openai' | 'anthropic';

export interface ModelMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	tool_calls?: ToolCall[];
	tool_call_id?: string;
	name?: string;
}

export interface ModelReply {
	content: string;
	toolCalls: ToolCall[];
}

export interface ModelRequest {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

// Which shape an endpoint speaks, when it is not stated: Anthropic's own
// host, else OpenAI's.
export function providerFor(settings: { provider?: string; url?: string }): OperatorProvider {
	if (settings.provider === 'anthropic' || settings.provider === 'openai') return settings.provider;
	return /(^|\.)anthropic\.com/.test(hostOf(settings.url)) ? 'anthropic' : 'openai';
}

function hostOf(url: string | undefined): string {
	try {
		return new URL(url ?? '').host;
	} catch {
		return '';
	}
}

const MAX_TOOL_TOKENS = 900;
const MAX_PLAIN_TOKENS = 300;

export function buildRequest(
	provider: OperatorProvider,
	config: { url: string; model: string; apiKey?: string },
	messages: ModelMessage[],
	tools: boolean
): ModelRequest {
	const base = config.url.replace(/\/$/, '');
	const maxTokens = tools ? MAX_TOOL_TOKENS : MAX_PLAIN_TOKENS;
	if (provider === 'anthropic') {
		return {
			url: `${base}/messages`,
			headers: {
				'content-type': 'application/json',
				'anthropic-version': '2023-06-01',
				...(config.apiKey ? { 'x-api-key': config.apiKey } : {})
			},
			body: anthropicBody(config.model, messages, tools, maxTokens)
		};
	}
	return {
		url: `${base}/chat/completions`,
		headers: {
			'content-type': 'application/json',
			...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {})
		},
		body: openAiBody(config.model, messages, tools, maxTokens)
	};
}

function openAiBody(model: string, messages: ModelMessage[], tools: boolean, maxTokens: number): Record<string, unknown> {
	const body: Record<string, unknown> = { model, messages, temperature: 0.2, max_tokens: maxTokens };
	if (tools) return { ...body, tools: OPERATOR_TOOLS, tool_choice: 'auto' };
	// A local thinking model would otherwise spend its whole budget
	// deliberating over a one-sentence summary. Servers that reject the field
	// get the request again without it (see server/operator.ts).
	return { ...body, chat_template_kwargs: { enable_thinking: false } };
}

// Anthropic keeps the system prompt out of the message list, pairs a tool
// result with its call by id, and names its tool schema `input_schema`.
function anthropicBody(model: string, messages: ModelMessage[], tools: boolean, maxTokens: number): Record<string, unknown> {
	const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
	const body: Record<string, unknown> = {
		model,
		max_tokens: maxTokens,
		temperature: 0.2,
		messages: messages.filter((m) => m.role !== 'system').map(anthropicMessage)
	};
	if (system) body.system = system;
	if (tools) {
		body.tools = OPERATOR_TOOLS.map((t) => ({
			name: t.function.name,
			description: t.function.description,
			input_schema: t.function.parameters
		}));
	}
	return body;
}

function anthropicMessage(message: ModelMessage): Record<string, unknown> {
	if (message.role === 'tool') {
		return {
			role: 'user',
			content: [{ type: 'tool_result', tool_use_id: message.tool_call_id ?? '', content: message.content }]
		};
	}
	if (message.role === 'assistant' && message.tool_calls?.length) {
		const blocks: Record<string, unknown>[] = [];
		if (message.content.trim()) blocks.push({ type: 'text', text: message.content });
		for (const call of message.tool_calls) {
			blocks.push({
				type: 'tool_use',
				id: call.id,
				name: call.function.name,
				input: safeJson(call.function.arguments)
			});
		}
		return { role: 'assistant', content: blocks };
	}
	return { role: message.role, content: message.content || '(no answer)' };
}

function safeJson(raw: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(raw || '{}');
		return parsed && typeof parsed === 'object' ? parsed : {};
	} catch {
		return {};
	}
}

interface OpenAiResponse {
	choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
}

interface AnthropicResponse {
	content?: { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
}

export function parseReply(provider: OperatorProvider, data: unknown): ModelReply {
	if (provider === 'anthropic') {
		const blocks = (data as AnthropicResponse).content ?? [];
		return {
			content: blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('').trim(),
			toolCalls: blocks
				.filter((b) => b.type === 'tool_use')
				.map((b) => ({
					id: b.id ?? '',
					type: 'function' as const,
					function: { name: b.name ?? '', arguments: JSON.stringify(b.input ?? {}) }
				}))
		};
	}
	const message = (data as OpenAiResponse).choices?.[0]?.message ?? {};
	return { content: (message.content ?? '').trim(), toolCalls: message.tool_calls ?? [] };
}

// What to tell the user when a model endpoint refuses.
export function providerError(provider: OperatorProvider, status: number): string {
	if (status === 401 || status === 403) {
		return provider === 'anthropic'
			? 'the operator model rejected the API key'
			: 'the operator model rejected the credentials';
	}
	if (status === 404) return 'the operator model endpoint was not found (check the URL and model id)';
	if (status === 429) return 'the operator model is rate limited';
	return `the operator model replied ${status}`;
}
