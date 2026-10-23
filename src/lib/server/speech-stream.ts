import crypto from 'node:crypto';
import { speechConfig } from './speech';

// Streaming transcription for voice mode: each open take gets one WebSocket to
// the configured streaming speech server (the OpenAI Realtime transcription
// shape: session.update, input_audio_buffer.append / .commit in, transcription
// deltas and a completed transcript out). Clients post 16 kHz 16-bit mono PCM
// chunks over plain HTTP and get the live text back on each reply, so a phone
// behind the lock screen needs no socket of its own and a dropped request only
// costs that take, which falls back to the batch upload.

const STREAM_SAMPLE_RATE = 16_000;
const OPEN_TIMEOUT_MS = 5_000;
const FINAL_TIMEOUT_MS = 10_000;
// A take the client abandoned (cancelled, or it lost the network) is closed
// after this long without a chunk.
const IDLE_MS = 15_000;
// How long a chunk's reply waits for the words in that chunk; a chunk of
// silence yields none, so this is also what each reply costs then.
const DELTA_WAIT_MS = 120;

interface RealtimeEvent {
	type?: string;
	delta?: string;
	transcript?: string;
	error?: { message?: string } | string;
}

function errorMessage(error: RealtimeEvent['error']): string {
	return (typeof error === 'string' ? error : error?.message) ?? 'error';
}

export class TranscriptStream {
	text = '';
	private error: string | null = null;
	private bytes = 0;
	private completed: ((text: string) => void) | null = null;
	private decoded: (() => void) | null = null;

	constructor(private socket: WebSocket) {
		socket.addEventListener('message', (e) => this.onMessage(e.data));
		socket.addEventListener('close', () => this.fail('the streaming speech server closed the connection'));
		socket.addEventListener('error', () => this.fail('the streaming speech server connection failed'));
		socket.send(
			JSON.stringify({
				type: 'session.update',
				session: { type: 'transcription', audio: { input: { format: { type: 'audio/pcm', rate: STREAM_SAMPLE_RATE }, turn_detection: null } } }
			})
		);
	}

	get seconds(): number {
		return this.bytes / 2 / STREAM_SAMPLE_RATE;
	}

	// Resolves once the server has decoded words from this chunk, or after a
	// short wait when it has none.
	append(pcm: Buffer): Promise<void> {
		if (this.error) throw new Error(this.error);
		if (!pcm.length) return Promise.resolve();
		const words = new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, DELTA_WAIT_MS);
			this.decoded = () => (clearTimeout(timer), resolve());
		});
		this.bytes += pcm.length;
		this.socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') }));
		return words;
	}

	// Commit what was sent and wait for the server's final transcript.
	async finish(): Promise<string> {
		if (this.error) throw new Error(this.error);
		const done = new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('the streaming speech server did not finish in time')), FINAL_TIMEOUT_MS);
			this.completed = (text) => {
				clearTimeout(timer);
				if (this.error) reject(new Error(this.error));
				else resolve(text);
			};
		});
		this.socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
		try {
			return await done;
		} finally {
			this.close();
		}
	}

	close(): void {
		this.error ??= 'stream closed';
		this.completed = null;
		this.socket.close();
	}

	private onMessage(data: unknown): void {
		let event: RealtimeEvent;
		try {
			event = JSON.parse(String(data)) as RealtimeEvent;
		} catch {
			return;
		}
		if (event.type === 'conversation.item.input_audio_transcription.delta') this.addWords(event.delta ?? '');
		if (event.type === 'conversation.item.input_audio_transcription.completed') this.complete(event.transcript ?? this.text);
		if (event.type === 'error') this.fail(`streaming speech server: ${errorMessage(event.error)}`);
	}

	private addWords(delta: string): void {
		this.text += delta;
		this.decoded?.();
		this.decoded = null;
	}

	private complete(transcript: string): void {
		this.text = transcript;
		this.completed?.(transcript.trim());
	}

	private fail(message: string): void {
		this.error ??= message;
		this.completed?.('');
	}
}

// ---- Open streams ----

interface OpenStream {
	stream: TranscriptStream;
	idle?: ReturnType<typeof setTimeout>;
}

const streams = new Map<string, OpenStream>();

function touch(id: string, open: OpenStream): void {
	clearTimeout(open.idle);
	open.idle = setTimeout(() => dropStream(id), IDLE_MS);
}

export function dropStream(id: string): void {
	const open = streams.get(id);
	if (!open) return;
	clearTimeout(open.idle);
	streams.delete(id);
	open.stream.close();
}

function connect(url: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		// An http(s) URL is taken to mean the same server's WebSocket.
		const socket = new WebSocket(url.replace(/^http/, 'ws'));
		const timer = setTimeout(() => {
			socket.close();
			reject(new Error('the streaming speech server did not answer'));
		}, OPEN_TIMEOUT_MS);
		socket.addEventListener('open', () => (clearTimeout(timer), resolve(socket)), { once: true });
		socket.addEventListener('error', () => (clearTimeout(timer), reject(new Error('could not reach the streaming speech server'))), { once: true });
	});
}

export async function openStream(): Promise<string> {
	const { streamUrl } = speechConfig();
	if (!streamUrl) throw new Error('no streaming speech server configured');
	const stream = new TranscriptStream(await connect(streamUrl));
	const id = crypto.randomUUID();
	const open: OpenStream = { stream };
	streams.set(id, open);
	touch(id, open);
	return id;
}

// The stream behind an id, kept alive for another idle window; null when it
// is unknown, expired or ended.
export function liveStream(id: string): TranscriptStream | null {
	const open = streams.get(id);
	if (!open) return null;
	touch(id, open);
	return open.stream;
}
