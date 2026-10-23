import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ settings: vi.fn() }));
vi.mock('./store', async (importOriginal) => ({ ...(await importOriginal<typeof import('./store')>()), readSettings: mocks.settings }));

// A streaming speech server: answers each append with a word and a commit with
// the joined transcript, the way the OpenAI Realtime transcription events do.
class FakeServer extends EventTarget {
	static last: FakeServer | null = null;
	static refuse = false;
	sent: { type: string; audio?: string }[] = [];
	closed = false;
	words = ['Open', ' the', ' pull', ' request.'];

	constructor(public url: string) {
		super();
		FakeServer.last = this;
		queueMicrotask(() => this.dispatchEvent(new Event(FakeServer.refuse ? 'error' : 'open')));
	}

	send(data: string) {
		const msg = JSON.parse(data);
		this.sent.push(msg);
		if (msg.type === 'input_audio_buffer.append') this.emit({ type: 'conversation.item.input_audio_transcription.delta', delta: this.words.shift() ?? '' });
		if (msg.type === 'input_audio_buffer.commit') queueMicrotask(() => this.emit({ type: 'conversation.item.input_audio_transcription.completed', transcript: ' Open the pull request. ' }));
	}

	emit(event: unknown) {
		this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(event) }));
	}

	close() {
		this.closed = true;
	}
}
vi.stubGlobal('WebSocket', FakeServer);

const { TranscriptStream } = await import('./speech-stream');
const { POST: open } = await import('../../routes/api/agent/speech/stream/+server');
const { POST: chunk } = await import('../../routes/api/agent/speech/stream/[id]/+server');
const { POST: end } = await import('../../routes/api/agent/speech/stream/[id]/end/+server');

const pcm = (bytes: number) => new Request('http://example.test/x', { method: 'POST', headers: { 'content-type': 'audio/pcm' }, body: new Uint8Array(bytes) });
const call = (handler: (event: never) => Response | Promise<Response>, id: string, bytes: number) => Promise.resolve(handler({ request: pcm(bytes), params: { id } } as never));
async function status(p: Response | Promise<Response>): Promise<number> {
	try {
		return (await p).status;
	} catch (e) {
		return (e as { status: number }).status;
	}
}

beforeEach(() => {
	FakeServer.refuse = false;
	mocks.settings.mockReturnValue({ speech: { sttUrl: 'http://stt.test', streamUrl: 'http://stt.test/v1/realtime?model=example' } });
});

describe('TranscriptStream', () => {
	it('asks for 16 kHz PCM, sends base64 audio, and resolves the completed transcript', async () => {
		const server = new FakeServer('ws://x');
		const stream = new TranscriptStream(server as unknown as WebSocket);
		stream.append(Buffer.from([1, 0, 2, 0]));
		expect(server.sent[0]).toMatchObject({ type: 'session.update', session: { audio: { input: { format: { type: 'audio/pcm', rate: 16000 } } } } });
		expect(server.sent[1]).toEqual({ type: 'input_audio_buffer.append', audio: 'AQACAA==' });
		expect(stream.text).toBe('Open');
		expect(await stream.finish()).toBe('Open the pull request.');
		expect(server.closed).toBe(true);
		expect(stream.seconds).toBeCloseTo(4 / 32000);
	});

	it('fails a take the server errors on, so the client falls back', async () => {
		const server = new FakeServer('ws://x');
		const stream = new TranscriptStream(server as unknown as WebSocket);
		server.emit({ type: 'error', error: { message: 'model not loaded' } });
		expect(() => stream.append(Buffer.from([1, 0]))).toThrow(/model not loaded/);
		await expect(stream.finish()).rejects.toThrow(/model not loaded/);
	});

	it('rejects a pending finish when the connection drops', async () => {
		const server = new FakeServer('ws://x');
		server.send = (data: string) => void server.sent.push(JSON.parse(data));
		const stream = new TranscriptStream(server as unknown as WebSocket);
		const done = stream.finish();
		server.dispatchEvent(new Event('close'));
		await expect(done).rejects.toThrow(/closed/);
	});
});

describe('stream routes', () => {
	it('opens, relays chunks with the live text, and ends with the final transcript', async () => {
		const { id } = await (await open({} as Parameters<typeof open>[0])).json();
		expect(FakeServer.last?.url).toBe('ws://stt.test/v1/realtime?model=example');
		expect(await (await call(chunk, id, 3200)).json()).toEqual({ text: 'Open' });
		expect(await (await call(chunk, id, 3200)).json()).toEqual({ text: 'Open the' });
		expect(await (await call(end, id, 0)).json()).toEqual({ text: 'Open the pull request.', seconds: 0.2 });
		expect(await status(call(chunk, id, 2))).toBe(404);
	});

	it('refuses without a streaming server, an unreachable one, or half a sample', async () => {
		mocks.settings.mockReturnValue({ speech: { sttUrl: 'http://stt.test' } });
		expect(await status(open({} as Parameters<typeof open>[0]))).toBe(400);
		mocks.settings.mockReturnValue({ speech: { streamUrl: 'ws://stt.test/v1/realtime' } });
		FakeServer.refuse = true;
		expect(await status(open({} as Parameters<typeof open>[0]))).toBe(502);
		FakeServer.refuse = false;
		const { id } = await (await open({} as Parameters<typeof open>[0])).json();
		expect(await status(call(chunk, id, 3))).toBe(400);
		expect(await status(call(chunk, 'nope', 2))).toBe(404);
	});
});
