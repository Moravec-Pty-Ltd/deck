import { matchSpokenAnswer, questionSpeech, type SpokenQuestion, type Chattiness, type EndOfSpeech, type VadSensitivity } from './speech-core';

// Node-free state for voice mode, shared by the web bar and unit-tested here:
// the utterance queue (what is left to read), the question flow (which
// question a spoken reply answers), and the per-device settings shape. The
// audio element, capture and detector live in voice.svelte.ts.

export interface Utterance {
	// Segments still to play, in order; the head is the one playing.
	segments: { id: string; text: string }[];
	// A cue to play before the first segment (the done cue ahead of a question),
	// or on its own when there are no segments (the done cue behind a reply).
	cue?: Cue;
	// Segments still being fetched. The utterance holds its place in the queue
	// meanwhile, so reads stay in order.
	pending?: Promise<{ id: string; text: string }[]>;
}

// Skip drops the head, and a cue waiting behind it with nothing to read.
export function skipUtterance(queue: Utterance[]): void {
	queue.shift();
	while (queue[0] && !queue[0].segments.length && !queue[0].pending) queue.shift();
}

export interface VoiceSettings {
	chattiness: Chattiness;
	handsFree: boolean;
	sensitivity: VadSensitivity;
	endOfSpeech: EndOfSpeech;
	// A soft tick while the agent works and nothing is being read.
	workingCue: boolean;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
	chattiness: 'every-update',
	handsFree: true,
	sensitivity: 'medium',
	endOfSpeech: 'normal',
	workingCue: true
};

const VOICE_SETTINGS_VERSION = 2;

export function serializeVoiceSettings(settings: VoiceSettings): string {
	return JSON.stringify({ ...settings, v: VOICE_SETTINGS_VERSION });
}

export function parseVoiceSettings(raw: string | null): VoiceSettings {
	if (!raw) return DEFAULT_VOICE_SETTINGS;
	try {
		const o = JSON.parse(raw) as Partial<VoiceSettings> & { v?: number };
		return {
			chattiness: o.chattiness === 'final-only' ? 'final-only' : 'every-update',
			// Settings saved before v2 stored the old hold-to-talk default, so they
			// move to hands-free once; a later choice of hold-to-talk sticks.
			handsFree: (o.v ?? 0) >= VOICE_SETTINGS_VERSION ? o.handsFree !== false : true,
			sensitivity: o.sensitivity === 'low' || o.sensitivity === 'high' ? o.sensitivity : 'medium',
			endOfSpeech: o.endOfSpeech === 'short' || o.endOfSpeech === 'long' ? o.endOfSpeech : 'normal',
			workingCue: o.workingCue !== false
		};
	} catch {
		return DEFAULT_VOICE_SETTINGS;
	}
}

// A blocking question being answered by voice: one question at a time, the
// picks so far, and how the finished answer is posted (the same text and
// structured picks the tapped card sends).
export interface AskFlow {
	toolUseId: string;
	questions: SpokenQuestion[];
	index: number;
	answers: { header: string; labels: string[] }[];
}

export function startAskFlow(toolUseId: string, questions: SpokenQuestion[]): AskFlow {
	return { toolUseId, questions, index: 0, answers: [] };
}

// What to read for the flow's current question.
export function askPrompt(flow: AskFlow): string {
	return questionSpeech(flow.questions[flow.index], flow.index, flow.questions.length);
}

// Fold a spoken reply into the flow: an option pick when it names one, else the
// reply as free text. Returns the advanced flow and whether every question now
// has an answer.
export function answerAskFlow(flow: AskFlow, transcript: string): { flow: AskFlow; done: boolean } {
	const q = flow.questions[flow.index];
	const picked = matchSpokenAnswer(transcript, q.options ?? []);
	const label = picked ?? transcript.trim();
	const answers = [...flow.answers, { header: q.header ?? q.question, labels: [label] }];
	const index = flow.index + 1;
	return { flow: { ...flow, index, answers }, done: index >= flow.questions.length };
}

// The text the agent receives for a completed flow, in the web card's format.
export function askAnswerText(flow: AskFlow): string {
	const lines = flow.answers.map((a) => `- ${a.header}: ${a.labels.join(', ')}`);
	return `Answering your question${flow.questions.length > 1 ? 's' : ''}:\n` + lines.join('\n');
}

// ---- Level meter / detector ----

// RMS of a PCM frame in [-1, 1].
export function rms(samples: ArrayLike<number>): number {
	let sum = 0;
	for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
	return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

export type VadState = 'silent' | 'opening' | 'open' | 'closing';

// A dip this short is the gap between words, not the end of speech.
const LOUD_GAP_MS = 120;

// Energy-gated voice activity: speech must hold above the threshold for
// `openMs` to open, and stay below it for `closeMs` to close. Time is passed
// in so it unit-tests without timers.
export class VoiceDetector {
	state: VadState = 'silent';
	private runStart: number | null = null;
	private quietSince: number | null = null;
	private since = 0;

	constructor(
		private threshold: number,
		private openMs: number,
		private closeMs: number
	) {}

	setThreshold(threshold: number) {
		this.threshold = threshold;
	}

	setCloseMs(closeMs: number) {
		this.closeMs = closeMs;
	}

	// Feed one level reading; returns 'start' when the mic should open,
	// 'stop' when it should close, else null.
	update(level: number, now: number): 'start' | 'stop' | null {
		const loud = level >= this.threshold;
		this.trackLoudness(loud, now);
		if (this.state === 'silent' || this.state === 'open') return this.settle(loud, now);
		return this.transition(loud, now);
	}

	// While quiet, when the quiet began; null while loud.
	get silentSince(): number | null {
		return this.quietSince;
	}

	// While loud, when this run of speech began, bridging dips shorter than
	// LOUD_GAP_MS between words; null while quiet.
	get loudSince(): number | null {
		return this.quietSince === null ? this.runStart : null;
	}

	private trackLoudness(loud: boolean, now: number): void {
		if (loud) {
			const gapEnded = this.quietSince !== null && now - this.quietSince >= LOUD_GAP_MS;
			this.runStart = gapEnded ? now : (this.runStart ?? now);
			this.quietSince = null;
			return;
		}
		this.quietSince ??= now;
		if (now - this.quietSince >= LOUD_GAP_MS) this.runStart = null;
	}

	// In a settled state a change of loudness starts the timer for the other.
	private settle(loud: boolean, now: number): null {
		const leaving = this.state === 'silent' ? loud : !loud;
		if (leaving) {
			this.state = this.state === 'silent' ? 'opening' : 'closing';
			this.since = now;
		}
		return null;
	}

	// Mid-transition, a reversal drops back; holding long enough completes it.
	private transition(loud: boolean, now: number): 'start' | 'stop' | null {
		const opening = this.state === 'opening';
		if (loud !== opening) {
			this.state = opening ? 'silent' : 'open';
			return null;
		}
		if (now - this.since < (opening ? this.openMs : this.closeMs)) return null;
		this.state = opening ? 'open' : 'silent';
		return opening ? 'start' : 'stop';
	}

	reset() {
		this.state = 'silent';
		this.runStart = null;
		this.quietSince = null;
	}
}

// A short message for the bar from a thrown value.
export function errorText(e: unknown, fallback: string): string {
	return e instanceof Error && e.message ? e.message : fallback;
}

// Whether a finished take is worth transcribing: not cancelled, long enough to
// hold a word, and non-empty.
export function isUsableTake(cancelled: boolean, durationMs: number, bytes: number, minMs: number): boolean {
	return !cancelled && durationMs >= minMs && bytes > 0;
}

// The newest chunks holding at least `capacity` samples, oldest first: the
// lead-in a take starts with, since the detector only opens once speech is
// already under way. Chunks are shared, never copied or written.
export class PcmRing {
	private chunks: Float32Array[] = [];
	private total = 0;

	constructor(private capacity: number) {}

	push(chunk: Float32Array): void {
		this.chunks.push(chunk);
		this.total += chunk.length;
		while (this.total - this.chunks[0].length >= this.capacity) this.total -= this.chunks.shift()!.length;
	}

	read(): Float32Array[] {
		return [...this.chunks];
	}
}

// Joins the chunks and box-filters them down to `to` Hz: each output sample
// averages the inputs it covers, enough low-pass for speech going to the
// recogniser.
export function downsample(chunks: Float32Array[], from: number, to: number): Float32Array {
	const input = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
	chunks.reduce((at, c) => (input.set(c, at), at + c.length), 0);
	if (to >= from) return input;
	const ratio = from / to;
	const out = new Float32Array(Math.floor(input.length / ratio));
	for (let i = 0; i < out.length; i++) {
		const a = Math.floor(i * ratio);
		const b = Math.floor((i + 1) * ratio);
		let sum = 0;
		for (let j = a; j < b; j++) sum += input[j];
		out[i] = sum / (b - a);
	}
	return out;
}

// Samples in [-1, 1] as 16-bit little-endian PCM, what a streamed take sends.
export function pcm16Bytes(samples: Float32Array): Uint8Array<ArrayBuffer> {
	const view = new DataView(new ArrayBuffer(samples.length * 2));
	samples.forEach((s, i) => {
		const v = Math.max(-1, Math.min(1, s));
		view.setInt16(i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
	});
	return new Uint8Array(view.buffer);
}

// A 16-bit mono PCM WAV file from samples in [-1, 1], the format the apps
// upload too.
export function wavBytes(samples: Float32Array, sampleRate: number): ArrayBuffer {
	const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
	const text = (at: number, s: string) => [...s].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)));
	text(0, 'RIFF');
	view.setUint32(4, 36 + samples.length * 2, true);
	text(8, 'WAVE');
	text(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	text(36, 'data');
	view.setUint32(40, samples.length * 2, true);
	new Uint8Array(view.buffer).set(pcm16Bytes(samples), 44);
	return view.buffer;
}

// Where the bar rests once a take (or playback) ends: hands-free keeps
// listening, push-to-talk waits.
export function restingStatus(handsFree: boolean, enabled: boolean): 'listening' | 'idle' {
	return handsFree && enabled ? 'listening' : 'idle';
}

export const TRANSCRIBING_CAPTION = 'Transcribing…';
export const LISTENING_CAPTION = 'Listening…';

// The caption for a resting bar: the transient "Transcribing" placeholder
// clears, a sent transcript stays visible, and hands-free listening says so
// when there is nothing else to show.
export function restingCaption(status: 'listening' | 'idle', caption: string): string {
	const current = caption === TRANSCRIBING_CAPTION ? '' : caption;
	return status === 'listening' && !current ? LISTENING_CAPTION : current;
}

// Unbroken loudness must hold this long to cut off a reply, longer than a take
// needs to open, so the reply's own echo or a cough doesn't.
export const BARGE_IN_HOLD_MS = 450;

// What a detector edge means for the recorder: open only when nothing is
// being captured or transcribed; close whenever it says so. While a reply
// plays, `loudSince` decides instead: speech held for BARGE_IN_HOLD_MS opens a
// take, which stops the reply.
export function vadAction(
	edge: 'start' | 'stop' | null,
	recording: boolean,
	transcribing: boolean,
	speaking: boolean,
	loudSince: number | null,
	now: number
): 'start' | 'stop' | null {
	if (edge === 'stop') return edge;
	if (recording || transcribing) return null;
	if (speaking) return loudSince !== null && now - loudSince >= BARGE_IN_HOLD_MS ? 'start' : null;
	return edge;
}

// Speech that opened the detector over a reply without cutting it stays
// pending until its stop edge, and acts as a start once the reply ends.
export function missedStart(
	edge: 'start' | 'stop' | null,
	speaking: boolean,
	missed: boolean
): { edge: 'start' | 'stop' | null; missed: boolean } {
	const pending = edge !== 'stop' && (missed || (edge === 'start' && speaking));
	return { edge: pending && !speaking ? 'start' : edge, missed: pending };
}

// ---- Cues ----

export type Cue = 'working' | 'done';

// How often the working cue ticks.
export const WORKING_CUE_MS = 3000;

// Each cue's notes as [Hz, ms] and its peak level. Every cue is shorter than
// VAD_OPEN_MS, so on an open mic it can't hold long enough to start a take.
const CUES: Record<Cue, { notes: [number, number][]; gain: number }> = {
	working: { notes: [[440, 40]], gain: 0.06 },
	done: { notes: [[990, 60], [660, 90]], gain: 0.25 }
};

// A cue as mono samples at `rate` Hz: sine notes with a 5 ms fade at each end
// so they don't click.
export function cueSamples(cue: Cue, rate: number): Float32Array {
	const { notes, gain } = CUES[cue];
	const fade = Math.round(rate * 0.005);
	const out = new Float32Array(notes.reduce((n, [, ms]) => n + Math.round((rate * ms) / 1000), 0));
	let at = 0;
	for (const [hz, ms] of notes) {
		const n = Math.round((rate * ms) / 1000);
		for (let i = 0; i < n; i++) out[at + i] = gain * Math.min(1, i / fade, (n - 1 - i) / fade) * Math.sin((2 * Math.PI * hz * i) / rate);
		at += n;
	}
	return out;
}

// What voice mode says once a take is sent, ChatGPT-style, so you know it was
// heard; they rotate so it doesn't sound canned. Short, so the server caches
// their audio once and they play at once after.
export const ACKNOWLEDGEMENTS = ['Got it.', 'On it.', 'Okay, checking.', 'Sure, one moment.'];

// The working cue ticks while the agent works (a turn running, or a message on
// its way) with the cue wanted, no question waiting, and nothing being
// recorded, transcribed or read.
export function workingCuePlays(wanted: boolean, working: boolean, asking: boolean, busy: boolean): boolean {
	return wanted && working && !asking && !busy;
}

// The done cue marks a turn's end only when no reply was read during it and no
// final reply is about to be.
export function doneCuePlays(willRead: boolean, replied: boolean): boolean {
	return !willRead && !replied;
}

// What a turn's end does in voice mode: read the final reply held back for
// it, and play the done cue when no reply was or will be read.
export function turnEnd(chattiness: Chattiness, held: string, replied: boolean): { read: string | null; done: boolean } {
	const read = chattiness === 'final-only' && held ? held : null;
	return { read, done: doneCuePlays(!!read, replied) };
}

// The segment to warm while the head plays: the rest of this utterance, else
// the start of the next.
export function nextSegment(queue: Utterance[]): { id: string } | undefined {
	return queue[0]?.segments[1] ?? queue[1]?.segments[0];
}
