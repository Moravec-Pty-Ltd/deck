import { describe, expect, it } from 'vitest';
import { loadTranscriptMode, saveTranscriptMode, TRANSCRIPT_MODE_KEY } from './transcript-mode';

function fakeStore(initial: Record<string, string> = {}) {
	const data = { ...initial };
	return {
		data,
		getItem: (k: string) => data[k] ?? null,
		setItem: (k: string, v: string) => {
			data[k] = v;
		}
	};
}

const throwing = {
	getItem() {
		throw new Error('private mode');
	},
	setItem() {
		throw new Error('quota exceeded');
	}
};

describe('transcript mode', () => {
	it('defaults to the full thread', () => {
		expect(loadTranscriptMode(fakeStore())).toBe('thread');
		expect(loadTranscriptMode(null)).toBe('thread');
		expect(loadTranscriptMode(fakeStore({ [TRANSCRIPT_MODE_KEY]: 'nonsense' }))).toBe('thread');
	});

	it('restores a stored chat choice', () => {
		expect(loadTranscriptMode(fakeStore({ [TRANSCRIPT_MODE_KEY]: 'chat' }))).toBe('chat');
	});

	it('round-trips through storage', () => {
		const store = fakeStore();
		saveTranscriptMode(store, 'chat');
		expect(loadTranscriptMode(store)).toBe('chat');
		saveTranscriptMode(store, 'thread');
		expect(loadTranscriptMode(store)).toBe('thread');
	});

	it('survives a storage that throws', () => {
		expect(loadTranscriptMode(throwing)).toBe('thread');
		expect(() => saveTranscriptMode(throwing, 'chat')).not.toThrow();
		expect(() => saveTranscriptMode(null, 'chat')).not.toThrow();
	});
});
