import { describe, expect, it } from 'vitest';
import { parseCodexModels, parseOpencodeModels, parsePiModels } from './models-core';

describe('parsePiModels', () => {
	it('parses the provider + model columns, skipping the header', () => {
		const out = `provider          model                          context  max-out  thinking  images
github-copilot    claude-fable-5                 1M       128K     yes       yes
openrouter-oauth  ~anthropic/claude-opus-latest  1M       128K     yes       yes
lmstudio          qwen3.6-27b-mlx                262.1K   32.8K    yes       no
`;
		expect(parsePiModels(out)).toEqual([
			{ provider: 'github-copilot', model: 'claude-fable-5' },
			{ provider: 'openrouter-oauth', model: '~anthropic/claude-opus-latest' },
			{ provider: 'lmstudio', model: 'qwen3.6-27b-mlx' }
		]);
	});

	it('returns [] for empty or header-only output', () => {
		expect(parsePiModels('')).toEqual([]);
		expect(parsePiModels('provider  model  context\n')).toEqual([]);
	});
});

describe('parseOpencodeModels', () => {
	it('keeps each provider/model line whole and drops noise', () => {
		const out = `opencode/big-pickle
acme/model-fast

not-a-model line with spaces
bareword
acme/model-pro
`;
		expect(parseOpencodeModels(out)).toEqual([
			{ model: 'opencode/big-pickle' },
			{ model: 'acme/model-fast' },
			{ model: 'acme/model-pro' }
		]);
	});

	it('returns [] for empty output', () => {
		expect(parseOpencodeModels('')).toEqual([]);
	});
});

describe('parseCodexModels', () => {
	it('lists visible slugs and drops hidden ones', () => {
		const raw = JSON.stringify({
			fetched_at: '2026-09-05T00:00:00Z',
			models: [
				{ slug: 'gpt-6-astra', visibility: 'list' },
				{ slug: 'gpt-reserve', visibility: 'hide' },
				{ slug: 'gpt-5.5', visibility: 'list' },
				{ visibility: 'list' },
				{ slug: '', visibility: 'list' }
			]
		});
		expect(parseCodexModels(raw)).toEqual([{ model: 'gpt-6-astra' }, { model: 'gpt-5.5' }]);
	});

	it('returns [] for malformed or empty cache', () => {
		expect(parseCodexModels('not json')).toEqual([]);
		expect(parseCodexModels('{}')).toEqual([]);
		expect(parseCodexModels('{"models": "nope"}')).toEqual([]);
	});
});
