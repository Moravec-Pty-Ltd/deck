import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-speech-test-'));
process.env.DECK_DATA = dataDir;

const mocks = vi.hoisted(() => ({ settings: vi.fn(), fetch: vi.fn() }));
vi.mock('./store', async (importOriginal) => ({ ...(await importOriginal<typeof import('./store')>()), readSettings: mocks.settings }));
vi.stubGlobal('fetch', mocks.fetch);
const speech = await import('./speech');
const { GET: capabilities } = await import('../../routes/api/speech/+server');
const { POST: segments } = await import('../../routes/api/speech/segments/+server');
const { GET: audio } = await import('../../routes/api/speech/audio/[id]/+server');
const { POST: transcribe } = await import('../../routes/api/speech/transcribe/+server');

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const wav = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);
function reply(body: unknown, status = 200): Response {
	if (body instanceof Uint8Array) return new Response(new Blob([body.buffer as ArrayBuffer]), { status, headers: { 'content-type': 'audio/wav' } });
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.settings.mockReturnValue({ speech: { ttsUrl: 'http://tts.test/', sttUrl: 'http://tts.test', voice: 'cortana' } });
	mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
		if (url.endsWith('/health')) return reply({ voices: ['cortana', 'other'], default_voice: 'cortana', stt: 'whisper' });
		if (url.endsWith('/v1/audio/speech')) return reply(wav);
		if (url.endsWith('/v1/audio/transcriptions')) {
			const form = init?.body as FormData;
			const file = form.get('file') as File;
			return reply({ text: ` heard ${file.name} `, seconds: 1.5 });
		}
		return reply({ message: 'unexpected' }, 404);
	});
});

describe('capabilities', () => {
	it('reports configured servers that answer, with the voice and stored urls', async () => {
		const body = await (await capabilities({} as Parameters<typeof capabilities>[0])).json();
		expect(body).toMatchObject({ tts: true, stt: true, voice: 'cortana', voices: ['cortana', 'other'] });
		expect(body.config).toEqual({ ttsUrl: 'http://tts.test', sttUrl: 'http://tts.test', voice: 'cortana' });
	});
	it('reports nothing when unconfigured or unreachable', async () => {
		mocks.settings.mockReturnValue({});
		expect(await speech.speechCapabilities()).toEqual({ tts: false, stt: false, voice: null, voices: [] });
		mocks.settings.mockReturnValue({ speech: { ttsUrl: 'http://down.test' } });
		mocks.fetch.mockRejectedValue(new Error('refused'));
		expect((await speech.speechCapabilities()).tts).toBe(false);
	});
});

describe('segments and audio', () => {
	function prepare(text: string) {
		return segments({ request: new Request('http://example.test/api/speech/segments', { method: 'POST', body: JSON.stringify({ text }) }) } as Parameters<typeof segments>[0]);
	}
	it('splits spoken text into content-addressed segments', async () => {
		const { segments: list } = await (await prepare('First sentence. **Second** one here.\n\n```js\nx\n```')).json();
		expect(list.map((s: { text: string }) => s.text)).toEqual(['First sentence. Second one here.', 'Code omitted.']);
		expect(list[0].id).toMatch(/^[a-f0-9]{20}$/);
		const again = await (await prepare('First sentence. Second one here.')).json();
		expect(again.segments[0].id).toBe(list[0].id);
	});
	it('keys ids to the voice', async () => {
		const a = await (await prepare('Hello there.')).json();
		mocks.settings.mockReturnValue({ speech: { ttsUrl: 'http://tts.test', voice: 'other' } });
		const b = await (await prepare('Hello there.')).json();
		expect(a.segments[0].id).not.toBe(b.segments[0].id);
	});
	it('synthesises once with verify off, then serves from disk', async () => {
		const { segments: [seg] } = await (await prepare('Cache me please.')).json();
		const first = await audio({ params: { id: seg.id } } as Parameters<typeof audio>[0]);
		expect(first.headers.get('content-type')).toBe('audio/wav');
		expect(new Uint8Array(await first.arrayBuffer())).toEqual(wav);
		const call = mocks.fetch.mock.calls.find(([url]) => String(url).endsWith('/v1/audio/speech'));
		expect(JSON.parse(String(call?.[1]?.body))).toEqual({ input: 'Cache me please.', voice: 'cortana', response_format: 'wav', verify: false });
		mocks.fetch.mockClear();
		const second = await audio({ params: { id: seg.id } } as Parameters<typeof audio>[0]);
		expect(second.status).toBe(200);
		expect(mocks.fetch).not.toHaveBeenCalled();
	});
	it('joins concurrent requests for one segment and rejects unknown ids', async () => {
		const { segments: [seg] } = await (await prepare('Concurrent request test.')).json();
		await Promise.all([speech.segmentAudio(seg.id), speech.segmentAudio(seg.id)]);
		expect(mocks.fetch.mock.calls.filter(([url]) => String(url).endsWith('/v1/audio/speech'))).toHaveLength(1);
		expect(await speech.segmentAudio('0123456789abcdef0123')).toBeNull();
		await expect(audio({ params: { id: '../etc/passwd' } } as Parameters<typeof audio>[0])).rejects.toMatchObject({ status: 404 });
	});
	it('refuses to prepare without a speech server', async () => {
		mocks.settings.mockReturnValue({});
		await expect(prepare('x')).rejects.toMatchObject({ status: 400 });
	});
});

describe('transcribe', () => {
	function post(body: Uint8Array | string, type?: string) {
		const payload = typeof body === 'string' ? body : new Blob([body.buffer as ArrayBuffer]);
		return transcribe({ request: new Request('http://example.test/api/speech/transcribe', { method: 'POST', body: payload, headers: type ? { 'content-type': type } : {} }) } as Parameters<typeof transcribe>[0]);
	}
	it('forwards the recording as a multipart file named for its container', async () => {
		expect(await (await post(new Uint8Array([1, 2, 3]), 'audio/mp4')).json()).toEqual({ text: 'heard speech.m4a', seconds: 1.5 });
		expect(await (await post(new Uint8Array([1, 2, 3]), 'audio/webm;codecs=opus')).json()).toEqual({ text: 'heard speech.webm', seconds: 1.5 });
	});
	it('rejects empty bodies, wrong types, and a missing server', async () => {
		await expect(post(new Uint8Array([]), 'audio/wav')).rejects.toMatchObject({ status: 400 });
		await expect(post(JSON.stringify({}), 'application/json')).rejects.toMatchObject({ status: 400 });
		mocks.settings.mockReturnValue({ speech: { ttsUrl: 'http://tts.test' } });
		await expect(post(new Uint8Array([1]), 'audio/wav')).rejects.toMatchObject({ status: 400 });
	});
});
