import { matchSpokenAnswer, questionSpeech, type SpokenQuestion, type Chattiness, type EndOfSpeech, type VadSensitivity } from './speech-core';

// Node-free state for voice mode, shared by the web bar and unit-tested here:
// the utterance queue (what is left to read), the question flow (which
// question a spoken reply answers), and the per-device settings shape. The
// audio element, capture and detector live in voice.svelte.ts.

export interface Utterance {
	// Segments still to play, in order; the head is the one playing.
	segments: { id: string; text: string }[];
}

export interface VoiceSettings {
	chattiness: Chattiness;
	handsFree: boolean;
	sensitivity: VadSensitivity;
	endOfSpeech: EndOfSpeech;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
	chattiness: 'every-update',
	handsFree: true,
	sensitivity: 'medium',
	endOfSpeech: 'normal'
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
			endOfSpeech: o.endOfSpeech === 'short' || o.endOfSpeech === 'long' ? o.endOfSpeech : 'normal'
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
	samples.forEach((s, i) => {
		const v = Math.max(-1, Math.min(1, s));
		view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
	});
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

// The segment to warm while the head plays: the rest of this utterance, else
// the start of the next.
export function nextSegment(queue: Utterance[]): { id: string } | undefined {
	return queue[0]?.segments[1] ?? queue[1]?.segments[0];
}
