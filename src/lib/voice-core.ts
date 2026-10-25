import { matchSpokenAnswer, questionSpeech, type SpokenQuestion, type Chattiness, type EndOfSpeech, type ReadOut, type VadSensitivity } from './speech-core';

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
	// Set on a tool-call announcement: the call it announces.
	toolUseId?: string;
}

// Skip drops the head, and a cue waiting behind it with nothing to read.
export function skipUtterance(queue: Utterance[]): void {
	queue.shift();
	while (queue[0] && !queue[0].segments.length && !queue[0].pending) queue.shift();
}

export interface VoiceSettings {
	chattiness: Chattiness;
	// A summary falls back to brief on the server when no operator model answers.
	readOut: ReadOut;
	handsFree: boolean;
	sensitivity: VadSensitivity;
	endOfSpeech: EndOfSpeech;
	// A soft tick while the agent works and nothing is being read.
	workingCue: boolean;
	// Say what the agent is doing ("Reading voice-core") in place of a tick.
	announceTools: boolean;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
	chattiness: 'every-update',
	readOut: 'summary',
	handsFree: true,
	sensitivity: 'medium',
	endOfSpeech: 'normal',
	workingCue: true,
	announceTools: true
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
			readOut: o.readOut === 'full' || o.readOut === 'brief' ? o.readOut : 'summary',
			// Settings saved before v2 stored the old hold-to-talk default, so they
			// move to hands-free once; a later choice of hold-to-talk sticks.
			handsFree: (o.v ?? 0) >= VOICE_SETTINGS_VERSION ? o.handsFree !== false : true,
			sensitivity: o.sensitivity === 'low' || o.sensitivity === 'high' ? o.sensitivity : 'medium',
			endOfSpeech: o.endOfSpeech === 'short' || o.endOfSpeech === 'long' ? o.endOfSpeech : 'normal',
			workingCue: o.workingCue !== false,
			announceTools: o.announceTools !== false
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

export type Cue = 'working' | 'done' | 'listening';

// How often the working cue ticks.
export const WORKING_CUE_MS = 3000;
// A reply still being prepared this long (a spoken summary from the model)
// gets a working cue at once rather than at the next tick.
export const WAITING_CUE_MS = 500;

// Each cue's notes as [Hz, ms] and its peak level. Every cue is shorter than
// VAD_OPEN_MS, so on an open mic it can't hold long enough to start a take.
const CUES: Record<Cue, { notes: [number, number][]; gain: number }> = {
	working: { notes: [[440, 40]], gain: 0.06 },
	done: { notes: [[990, 60], [660, 90]], gain: 0.25 },
	// Rising, the done cue's mirror: the mic is open.
	listening: { notes: [[660, 50], [990, 70]], gain: 0.2 }
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

// The listening cue plays when hands-free listening resumes (voice mode
// turned on, a reply or announcement finished), with nothing left to read and
// no take opening.
export function listeningCuePlays(was: string, now: string, reading: boolean, micBusy: boolean): boolean {
	return now === 'listening' && was !== 'listening' && !reading && !micBusy;
}

// ---- Tool-call announcements ----

// At most one announcement this often.
export const ANNOUNCE_MS = 4000;
// Calls landing within this of each other are announced together.
export const ANNOUNCE_SETTLE_MS = 300;

// What a tool call is doing, for speech: `one` names this call, `many` the
// merged phrase for several of the same kind landing together, with `#` for
// the count.
export interface ToolAction {
	kind: string;
	one: string;
	many: string;
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

// The file name without its folder or extension: "SessionDetailView".
function fileName(path: unknown): string {
	const base = String(path ?? '').split('/').filter(Boolean).pop() ?? '';
	return base.replace(/\.[^.]+$/, '') || base;
}

// The first word or two of a shell command, past any `cd` and env vars, and
// before the first flag or path: "pnpm test", "git status".
function commandWords(command: unknown): string {
	const parts = String(command ?? '').split(/&&|\|\||;|\||\n/).map((p) => p.trim());
	const words = (parts.find((p) => p && !/^cd\b/.test(p)) ?? '').split(/\s+/).filter((w) => w && !/^\w+=/.test(w));
	if (!words.length) return 'a command';
	words[0] = fileName(words[0]);
	const end = words.findIndex((w, i) => i >= 2 || /^-|[/.]/.test(w));
	return words.slice(0, end < 0 ? 2 : Math.max(1, end)).join(' ');
}

function host(url: unknown): string {
	try {
		return new URL(String(url)).hostname.replace(/^www\./, '') || 'a page';
	} catch {
		return 'a page';
	}
}

// Up to four words of free text, without regex or glob punctuation.
function words(text: unknown): string {
	return String(text ?? '').replace(/[^\p{L}\p{N}' -]+/gu, ' ').trim().split(/\s+/).slice(0, 4).join(' ');
}

// "mcp__deck__send_message" and "TodoWrite" as "send message" and "todo write".
function toolWords(name: string): string {
	return name.replace(/^mcp__.+__/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
}

function action(kind: string, one: string, many: string): ToolAction {
	return { kind, one: one.trim(), many };
}

// A tool call as speech, after the headers ToolCall.svelte shows. Questions
// are read out whole instead.
export function toolAction(name: string, input: Record<string, unknown> = {}): ToolAction {
	switch (name) {
		case 'Read':
			return action('read', `Reading ${fileName(input.file_path)}`, 'Reading # files');
		case 'Edit':
		case 'MultiEdit':
		case 'NotebookEdit':
			return action('edit', `Editing ${fileName(input.file_path ?? input.notebook_path)}`, 'Editing # files');
		case 'Write':
			return action('write', `Writing ${fileName(input.file_path)}`, 'Writing # files');
		case 'Bash':
			return action('run', `Running ${commandWords(input.command)}`, 'Running # commands');
		case 'Grep': {
			const what = words(input.pattern);
			return action('search', what ? `Searching for ${what}` : 'Searching the code', 'Running # searches');
		}
		case 'Glob':
			return action('search', 'Finding files', 'Running # searches');
		case 'WebSearch': {
			const what = words(input.query);
			return action('websearch', what ? `Searching the web for ${what}` : 'Searching the web', 'Running # web searches');
		}
		case 'WebFetch': {
			return action('fetch', `Fetching ${host(input.url)}`, 'Fetching # pages');
		}
		case 'Agent':
		case 'Task': {
			const what = words(input.subagent_type ?? input.description);
			return action('agent', what ? `Starting a subagent: ${what}` : 'Starting a subagent', 'Starting # subagents');
		}
		case 'TodoWrite':
			return action('todo', 'Updating the to-do list', 'Updating the to-do list');
		default:
			return action(name, `Using ${toolWords(name)}`, `Using ${toolWords(name)} # times`);
	}
}

// The phrase for the calls since the last announcement: the newest call, or
// "Reading three files" when the newest few are the same kind.
export function announcement(actions: ToolAction[]): string | null {
	const last = actions.at(-1);
	if (!last) return null;
	let n = 0;
	for (let i = actions.length - 1; i >= 0 && actions[i].kind === last.kind; i--) n++;
	return n > 1 ? last.many.replace('#', NUMBER_WORDS[n] ?? String(n)) : last.one;
}

// An announcement plays with the setting on, the agent working, no question
// waiting, nothing being recorded, transcribed, read or queued, and the last
// one at least ANNOUNCE_MS ago.
export function announcePlays(wanted: boolean, working: boolean, asking: boolean, busy: boolean, sinceLastMs: number): boolean {
	return wanted && working && !asking && !busy && sinceLastMs >= ANNOUNCE_MS;
}

// A queued announcement is dropped unplayed once a newer tool call has
// started or anything else is queued behind it.
export function announcementStale(head: Utterance, latestToolUseId: string | null, queueLength: number): boolean {
	return !!head.toolUseId && (head.toolUseId !== latestToolUseId || queueLength > 1);
}
