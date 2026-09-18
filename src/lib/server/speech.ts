import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SpeechSettings } from '$lib/types';
import { segmentSpeech, spokenText, type SpeechCapabilities, type SpeechSegment } from '$lib/speech-core';
import { speechDir } from './config';
import { readSettings } from './store';
import { createTtlCache } from './ttl-cache';

// Voice mode's server half: resolve the configured speech servers, turn reply
// text into content-addressed sentence segments, synthesise each on first
// request (cached on disk so a reconnect or second device never regenerates),
// and forward push-to-talk audio for transcription. Both servers speak the
// OpenAI audio shapes; the local chatterbox server also takes `verify:false`
// for a fast single take, which is what a live reply wants.

const PROBE_TIMEOUT_MS = 2_000;
const TTS_TIMEOUT_MS = 60_000;
const STT_TIMEOUT_MS = 60_000;
// The local server deck's own docs point at; "Detect" probes it.
const LOCAL_SPEECH_URL = 'http://127.0.0.1:17496';

function trimUrl(url: string | undefined): string | undefined {
	const trimmed = url?.trim().replace(/\/+$/, '');
	return trimmed || undefined;
}

export function speechConfig(): SpeechSettings {
	const s = readSettings().speech ?? {};
	return { ttsUrl: trimUrl(s.ttsUrl), sttUrl: trimUrl(s.sttUrl), voice: s.voice?.trim() || undefined };
}

interface Health {
	voices?: string[];
	default_voice?: string;
	stt?: string | null;
}

async function probe(url: string): Promise<Health | null> {
	try {
		const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
		if (!res.ok) return null;
		return (await res.json()) as Health;
	} catch {
		return null;
	}
}

// Probing on every capability read would add a round trip per session open;
// a server that just went away is noticed within the window.
const healthCache = createTtlCache<Health | null>(30_000);
function cachedHealth(url: string): Promise<Health | null> {
	return healthCache.getOrFetch(url, false, () => probe(url));
}

// What the clients can offer: only servers that are configured and answer.
export async function speechCapabilities(): Promise<SpeechCapabilities> {
	const { ttsUrl, sttUrl, voice } = speechConfig();
	const [tts, stt] = await Promise.all([
		ttsUrl ? cachedHealth(ttsUrl) : null,
		sttUrl ? cachedHealth(sttUrl) : null
	]);
	const voices = tts?.voices ?? [];
	return {
		tts: !!tts,
		stt: !!stt,
		voice: tts ? (voice ?? tts.default_voice ?? voices[0] ?? null) : null,
		voices
	};
}

// The local chatterbox server, when it is running: enough for the Settings
// page to fill the fields in one click.
export async function detectLocalSpeechServer(): Promise<{ url: string; voices: string[]; voice: string | null; stt: boolean } | null> {
	const health = await probe(LOCAL_SPEECH_URL);
	if (!health) return null;
	return {
		url: LOCAL_SPEECH_URL,
		voices: health.voices ?? [],
		voice: health.default_voice ?? null,
		stt: !!health.stt
	};
}

// ---- Segments ----

const MAX_SPEECH_CHARS = 20_000;
// Text ids are kept in memory for the process's life and mirrored to disk, so a
// restart (or a second deck process) can still synthesise an id a client holds.
const texts = new Map<string, string>();

function segmentId(voice: string, text: string): string {
	return crypto.createHash('sha1').update(`${voice}\n${text}`).digest('hex').slice(0, 20);
}

const ID_RE = /^[a-f0-9]{20}$/;
function segmentFile(id: string, ext: 'txt' | 'wav'): string {
	return path.join(speechDir, `${id}.${ext}`);
}

// Sentence segments for a reply, ids keyed to the current voice so a voice
// change never serves the old voice's audio.
export function prepareSegments(markdown: string): SpeechSegment[] {
	const { voice } = speechConfig();
	const spoken = spokenText(markdown.slice(0, MAX_SPEECH_CHARS));
	return segmentSpeech(spoken).map((text) => {
		const id = segmentId(voice ?? '', text);
		if (!texts.has(id)) {
			texts.set(id, text);
			fs.writeFile(segmentFile(id, 'txt'), text, () => {});
		}
		return { id, text };
	});
}

function segmentText(id: string): string | null {
	const known = texts.get(id);
	if (known) return known;
	try {
		const text = fs.readFileSync(segmentFile(id, 'txt'), 'utf8');
		texts.set(id, text);
		return text;
	} catch {
		return null;
	}
}

async function synthesise(text: string): Promise<Buffer> {
	const { ttsUrl, voice } = speechConfig();
	if (!ttsUrl) throw new Error('no text-to-speech server configured');
	const res = await fetch(`${ttsUrl}/v1/audio/speech`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ input: text, voice, response_format: 'wav', verify: false }),
		signal: AbortSignal.timeout(TTS_TIMEOUT_MS)
	});
	if (!res.ok) throw new Error(`speech server ${res.status}: ${(await res.text()).slice(0, 200)}`);
	return Buffer.from(await res.arrayBuffer());
}

// One synthesis per id at a time: the client prefetches the next segment while
// the current plays, and a second device asking for the same id joins the
// in-flight request rather than starting another.
const inflight = new Map<string, Promise<Buffer>>();

// The audio for a prepared segment: from disk when it exists, else synthesised
// and written. Null when the id is unknown (never prepared, or pruned).
export async function segmentAudio(id: string): Promise<Buffer | null> {
	if (!ID_RE.test(id)) return null;
	try {
		return await fs.promises.readFile(segmentFile(id, 'wav'));
	} catch {
		// not cached yet
	}
	const text = segmentText(id);
	if (!text) return null;
	let job = inflight.get(id);
	if (!job) {
		job = synthesise(text)
			.then(async (wav) => {
				await fs.promises.writeFile(segmentFile(id, 'wav'), wav);
				return wav;
			})
			.finally(() => inflight.delete(id));
		inflight.set(id, job);
	}
	return job;
}

// ---- Transcription ----

export interface Transcription {
	text: string;
	seconds: number;
}

// Push-to-talk audio (any container the server's ffmpeg reads) to text.
export async function transcribeAudio(audio: Buffer, mimeType: string): Promise<Transcription> {
	const { sttUrl } = speechConfig();
	if (!sttUrl) throw new Error('no speech-to-text server configured');
	const form = new FormData();
	const ext = mimeType.includes('webm') ? 'webm' : mimeType.includes('mp4') || mimeType.includes('m4a') ? 'm4a' : mimeType.includes('ogg') ? 'ogg' : 'wav';
	form.set('file', new Blob([new Uint8Array(audio)], { type: mimeType }), `speech.${ext}`);
	form.set('language', 'en');
	const res = await fetch(`${sttUrl}/v1/audio/transcriptions`, {
		method: 'POST',
		body: form,
		signal: AbortSignal.timeout(STT_TIMEOUT_MS)
	});
	if (!res.ok) throw new Error(`transcription server ${res.status}: ${(await res.text()).slice(0, 200)}`);
	const out = (await res.json()) as { text?: string; seconds?: number };
	return { text: (out.text ?? '').trim(), seconds: out.seconds ?? 0 };
}

// ---- Cache upkeep ----

// Segments older than this are unlikely to be replayed; prune on the first
// prepare after the interval so the dir doesn't grow for months.
const PRUNE_AFTER_MS = 7 * 24 * 3600 * 1000;
const PRUNE_EVERY_MS = 3600 * 1000;
let lastPrune = 0;

export function pruneSpeechCache(now = Date.now()): void {
	if (now - lastPrune < PRUNE_EVERY_MS) return;
	lastPrune = now;
	let names: string[];
	try {
		names = fs.readdirSync(speechDir);
	} catch {
		return;
	}
	for (const name of names) {
		const file = path.join(speechDir, name);
		try {
			if (now - fs.statSync(file).mtimeMs > PRUNE_AFTER_MS) {
				fs.unlinkSync(file);
				texts.delete(name.replace(/\.(txt|wav)$/, ''));
			}
		} catch {
			// gone already
		}
	}
}
