import { matchSpokenAnswer, questionSpeech, type SpokenQuestion, type Chattiness, type VadSensitivity } from './speech-core';

// Node-free state for voice mode, shared by the web bar and unit-tested here:
// the utterance queue (what is left to read), the question flow (which
// question a spoken reply answers), and the per-device settings shape. The
// audio element, recorder and detector live in voice.svelte.ts.

export interface Utterance {
	// Segments still to play, in order; the head is the one playing.
	segments: { id: string; text: string }[];
}

export interface VoiceSettings {
	chattiness: Chattiness;
	handsFree: boolean;
	sensitivity: VadSensitivity;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
	chattiness: 'every-update',
	handsFree: false,
	sensitivity: 'medium'
};

export function parseVoiceSettings(raw: string | null): VoiceSettings {
	if (!raw) return DEFAULT_VOICE_SETTINGS;
	try {
		const o = JSON.parse(raw) as Partial<VoiceSettings>;
		return {
			chattiness: o.chattiness === 'final-only' ? 'final-only' : 'every-update',
			handsFree: o.handsFree === true,
			sensitivity: o.sensitivity === 'low' || o.sensitivity === 'high' ? o.sensitivity : 'medium'
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

// Energy-gated voice activity: speech must hold above the threshold for
// `openMs` to open, and stay below it for `closeMs` to close. Time is passed
// in so it unit-tests without timers.
export class VoiceDetector {
	state: VadState = 'silent';
	private since = 0;

	constructor(
		private threshold: number,
		private openMs: number,
		private closeMs: number
	) {}

	setThreshold(threshold: number) {
		this.threshold = threshold;
	}

	// Feed one level reading; returns 'start' when the mic should open,
	// 'stop' when it should close, else null.
	update(level: number, now: number): 'start' | 'stop' | null {
		const loud = level >= this.threshold;
		if (this.state === 'silent' || this.state === 'open') return this.settle(loud, now);
		return this.transition(loud, now);
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

// The recorder container to ask for, first supported wins; undefined lets the
// browser pick.
export function pickRecorderType(supported: (type: string) => boolean): string | undefined {
	return ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'].find(supported);
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

// What a detector edge means for the recorder: open only when nothing is
// being captured or transcribed; close whenever it says so.
export function vadAction(
	edge: 'start' | 'stop' | null,
	recording: boolean,
	transcribing: boolean
): 'start' | 'stop' | null {
	if (edge === 'start') return recording || transcribing ? null : 'start';
	return edge;
}

// The segment to warm while the head plays: the rest of this utterance, else
// the start of the next.
export function nextSegment(queue: Utterance[]): { id: string } | undefined {
	return queue[0]?.segments[1] ?? queue[1]?.segments[0];
}
