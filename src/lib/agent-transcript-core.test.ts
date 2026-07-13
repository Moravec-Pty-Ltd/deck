import { describe, it, expect } from 'vitest';
import { projectTranscript } from './agent-transcript-core';

const assistant = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const user = (text: string) => ({ type: 'user', message: { content: text } });

describe('projectTranscript', () => {
	it('extracts user/assistant prose and the last assistant reply', () => {
		const out = projectTranscript([user('do the thing'), assistant('on it'), assistant('done: PR opened')]);
		expect(out.messages).toEqual([
			{ role: 'user', text: 'do the thing' },
			{ role: 'assistant', text: 'on it' },
			{ role: 'assistant', text: 'done: PR opened' }
		]);
		expect(out.lastResult).toBe('done: PR opened');
	});

	it('joins multi-block assistant text and trims', () => {
		const ev = { type: 'assistant', message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b ' }] } };
		expect(projectTranscript([ev]).lastResult).toBe('ab');
	});

	it('drops tool calls, tool results, and deck markers', () => {
		const events = [
			{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
			{ type: 'user', message: { content: [{ type: 'tool_result', content: 'output' }] } },
			{ type: 'result', subtype: 'success' },
			{ type: 'deck.model', model: 'opus' },
			{ type: 'deck.unreadable' }
		];
		const out = projectTranscript(events);
		expect(out.messages).toEqual([]);
		expect(out.lastResult).toBeNull();
	});

	it('caps the message list to the tail', () => {
		const many = Array.from({ length: 60 }, (_, i) => assistant(`m${i}`));
		const out = projectTranscript(many);
		expect(out.messages).toHaveLength(40);
		expect(out.messages[0].text).toBe('m20');
		expect(out.lastResult).toBe('m59');
	});

	it('is empty for a transcript with no prose', () => {
		expect(projectTranscript([])).toEqual({ messages: [], lastResult: null });
	});
});
