// Pure logic for voice mode, shared by the server (what to synthesise) and the
// web client (what to do with a spoken reply). Node-free so it unit-tests
// without a speech server; the fetches live in server/speech.ts.

export interface SpeechCapabilities {
	// Whether a text-to-speech / speech-to-text server is configured and up.
	tts: boolean;
	stt: boolean;
	// Whether a streaming speech-to-text server is configured and up: takes can
	// then stream to POST /api/agent/speech/stream and end on the live words.
	stream: boolean;
	// The voice replies are read in, and the voices the server offers.
	voice: string | null;
	voices: string[];
}

export interface SpeechSegment {
	id: string;
	text: string;
}

// ---- Markdown to speech ----

// Fenced code and tables read as noise aloud, so each becomes a short marker
// the listener can act on (open the transcript); everything else keeps its
// words and loses its syntax.
const CODE_MARKER = 'Code omitted.';
const TABLE_MARKER = 'Table omitted.';

function stripTables(text: string): string {
	const out: string[] = [];
	let inTable = false;
	for (const line of text.split('\n')) {
		const isRow = /^\s*\|.*\|\s*$/.test(line);
		if (isRow) {
			if (!inTable) out.push(TABLE_MARKER);
			inTable = true;
			continue;
		}
		inTable = false;
		out.push(line);
	}
	return out.join('\n');
}

// A bare URL is read as its host ("example.com"), which is all a listener can
// use; a markdown link keeps its text only.
function hostOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, '');
	} catch {
		return 'link';
	}
}

export function spokenText(markdown: string): string {
	let t = markdown.replace(/\r\n/g, '\n');
	t = t.replace(/```[\s\S]*?(```|$)/g, `\n${CODE_MARKER}\n`);
	t = stripTables(t);
	t = t.replace(/<[^>\n]+>/g, ' ');
	t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
	t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
	t = t.replace(/https?:\/\/[^\s)>\]]+/g, (url) => hostOf(url));
	// Line-leading syntax; [ \t] rather than \s so a match never eats the newline
	// (and the paragraph break) in front of it.
	t = t.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '');
	t = t.replace(/^[ \t]*>[ \t]?/gm, '');
	t = t.replace(/^[ \t]*(?:[-*+•]|\d+[.)])[ \t]+/gm, '');
	t = t.replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, '');
	t = t.replace(/(\*\*|__)(.+?)\1/g, '$2');
	t = t.replace(/(?<![\w`])[*_]([^*_\n]+)[*_](?![\w`])/g, '$1');
	t = t.replace(/~~(.+?)~~/g, '$1');
	t = t.replace(/`([^`\n]*)`/g, '$1');
	t = t.replace(/[ \t]+/g, ' ');
	t = t.replace(/\n{3,}/g, '\n\n');
	return t.trim();
}

// ---- Brief replies ----

// A long reply read aloud runs for minutes, so voice mode reads its opening:
// the prose before the first heading, list, code block or table, capped at
// BRIEF_CHARS (about 20 seconds of speech) and cut at a sentence end.
const BRIEF_CHARS = 300;
export const REST_ON_SCREEN = 'The rest is on screen.';
const STRUCTURE = /^\s{0,3}(?:#{1,6}\s|[-*+•]\s|\d+[.)]\s|\|)/;
const FENCE = /^\s{0,3}```/;

function lineKind(line: string, fenced: boolean): 'fence' | 'structure' | 'prose' | 'other' {
	if (FENCE.test(line)) return 'fence';
	if (fenced || !line.trim()) return 'other';
	return STRUCTURE.test(line) ? 'structure' : 'prose';
}

// The markdown before the first structure that follows some prose; a reply
// that opens with structure is kept whole here and left to the length cap.
// Prose never starts inside a fence, so once there is prose nothing is fenced.
function openingProse(markdown: string): string {
	const lines = markdown.replace(/\r\n/g, '\n').split('\n');
	let prose = false;
	let fenced = false;
	for (let i = 0; i < lines.length; i++) {
		const kind = lineKind(lines[i], fenced);
		if (prose && kind !== 'prose' && kind !== 'other') return lines.slice(0, i).join('\n');
		if (kind === 'fence') fenced = !fenced;
		prose ||= kind === 'prose';
	}
	return markdown;
}

// The last sentence end within BRIEF_CHARS, else the last word break (also
// when the only sentence end is a short lead-in like "Sure.").
function capAtSentence(text: string): string {
	if (text.length <= BRIEF_CHARS) return text;
	const head = text.slice(0, BRIEF_CHARS + 1);
	const last = [...head.matchAll(/[.!?…]["')\]]?(?=\s)/g)].at(-1);
	const end = last ? last.index + last[0].length : 0;
	if (end >= BRIEF_CHARS / 3) return head.slice(0, end);
	const space = head.lastIndexOf(' ');
	return space > 0 ? head.slice(0, space) : head.slice(0, BRIEF_CHARS);
}

// The plain text to read for a reply in voice mode: the whole of a short one,
// the opening of a long one followed by REST_ON_SCREEN.
export function briefSpokenText(markdown: string): string {
	const whole = spokenText(markdown);
	if (whole.length <= BRIEF_CHARS) return whole;
	return `${capAtSentence(spokenText(openingProse(markdown)))} ${REST_ON_SCREEN}`;
}

// ---- Spoken summaries ----

// A reply longer than the brief read-out is summarised by the operator's model
// rather than cut at its opening; a short one is read word for word.
export function wantsSummary(markdown: string): boolean {
	return spokenText(markdown).length > BRIEF_CHARS;
}

// The read-out a segments request asks for; `brief: true` is the older form
// of `readOut: 'brief'`, still sent by older apps.
export function readOutOf(body: Record<string, unknown>): ReadOut {
	if (body.readOut === 'summary' || body.readOut === 'brief' || body.readOut === 'full') return body.readOut;
	return body.brief === true ? 'brief' : 'full';
}

// What to segment: the summary, else the reply. `brief` makes prepareSegments
// read it through briefSpokenText, which cuts the reply to its opening when the
// summary never came, and caps a summary that ran long at the same length.
export function readOutText(reply: string, readOut: ReadOut, summary: string | null): { text: string; brief: boolean } {
	return { text: summary ?? reply, brief: readOut !== 'full' };
}

export function spokenSummaryMessages(reply: string): { role: 'system' | 'user'; content: string }[] {
	return [
		{
			role: 'system',
			content:
				"Summarise a coding agent's reply for someone listening hands-free, in two or three short spoken sentences: the outcome, then anything they need to decide or do. Plain text, no markdown, no lists, no file paths or code, no preamble."
		},
		// The outcome is usually at the end, so a long reply keeps its head and tail.
		{ role: 'user', content: reply.length > 6000 ? `${reply.slice(0, 2000)}\n...\n${reply.slice(-4000)}` : reply }
	];
}

// ---- Sentence segments ----

// A segment is what one synthesis request produces and what the client plays
// as a unit. Short segments start playback sooner; the first one is cut as
// soon as it holds a sentence or two of real length, later ones pack more.
const SEGMENT_CHARS = 200;
const FIRST_SEGMENT_CHARS = 60;
const SEGMENT_MAX = 320;
const SENTENCE_END = /(?<=[.!?…]["')\]]?)\s+(?=\S)/;

function splitLong(sentence: string): string[] {
	if (sentence.length <= SEGMENT_MAX) return [sentence];
	const parts = sentence.split(/(?<=[,;:])\s+/);
	const out: string[] = [];
	let cur = '';
	for (const p of parts) {
		if (cur && cur.length + p.length + 1 > SEGMENT_CHARS) {
			out.push(cur);
			cur = p;
		} else {
			cur = cur ? `${cur} ${p}` : p;
		}
	}
	if (cur) out.push(cur);
	return out;
}

function sentencesOf(paragraph: string): string[] {
	return paragraph
		.split(SENTENCE_END)
		.map((s) => s.trim())
		.filter(Boolean)
		.flatMap(splitLong);
}

// Pack a paragraph's sentences into segments, appending to `segments`. The
// first segment of a reply is cut short so playback starts within one small
// synthesis; after that, pack to keep the request count down.
function packSentences(sentences: string[], segments: string[]): void {
	let cur = '';
	for (const s of sentences) {
		const limit = segments.length === 0 ? FIRST_SEGMENT_CHARS : SEGMENT_CHARS;
		if (cur && cur.length + s.length + 1 > limit) {
			segments.push(cur);
			cur = s;
		} else {
			cur = cur ? `${cur} ${s}` : s;
		}
	}
	if (cur) segments.push(cur);
}

export function segmentSpeech(text: string): string[] {
	const segments: string[] = [];
	for (const paragraph of text.split(/\n\s*\n|\n/)) packSentences(sentencesOf(paragraph), segments);
	return segments;
}

// ---- Questions ----

export interface SpokenOption {
	label: string;
	description?: string;
}

export interface SpokenQuestion {
	question: string;
	header?: string;
	options?: SpokenOption[];
}

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const NUMBER_WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

// How a blocking question is read: the question, then numbered options so a
// spoken "two" is enough to pick one. A set of questions counts them off.
export function questionSpeech(q: SpokenQuestion, index = 0, total = 1): string {
	const parts: string[] = [];
	parts.push(total > 1 ? `Question ${index + 1} of ${total}. ${q.question}` : q.question);
	const options = q.options ?? [];
	if (options.length) {
		const listed = options.map((o, i) => `${NUMBER_WORDS[i] ?? i + 1}, ${o.label}`).join('. ');
		parts.push(`Options: ${listed}.`);
	}
	return parts.join(' ');
}

function normalise(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

// The option a spoken reply picks: its label (whole or as the leading words),
// a number ("two", "2", "option two", "number 2"), or an ordinal ("the second
// one"). Null means send the reply as free text.
export function matchSpokenAnswer(transcript: string, options: SpokenOption[]): string | null {
	const said = normalise(transcript);
	if (!said || !options.length) return null;
	const labels = options.map((o) => normalise(o.label));
	// Naming two options is a sentence for the agent, not a pick.
	const contained = labels.map((l, i) => (l && ` ${said} `.includes(` ${l} `) ? i : -1)).filter((i) => i >= 0);
	if (contained.length > 1) return null;
	const exact = labels.findIndex((l) => l && l === said);
	if (exact >= 0) return options[exact].label;
	const stripped = said
		.replace(/^(?:option|number|the|choose|pick|select|go with)\s+/g, '')
		.replace(/\s+(?:one|option|please)$/g, '');
	for (let i = 0; i < options.length; i++) {
		const tokens = [String(i + 1), NUMBER_WORDS[i], ORDINALS[i]].filter(Boolean);
		if (tokens.includes(stripped)) return options[i].label;
	}
	return contained.length === 1 ? options[contained[0]].label : null;
}

// ---- Client-side settings ----

export type Chattiness = 'every-update' | 'final-only';
// How much of a reply voice mode reads: all of it, its opening, or a model's summary.
export type ReadOut = 'full' | 'brief' | 'summary';
export type VadSensitivity = 'low' | 'medium' | 'high';
export type EndOfSpeech = 'short' | 'normal' | 'long';

// RMS thresholds (0..1 amplitude) for the energy detector, per sensitivity.
// High opens on quieter speech and so also on more room noise.
export const VAD_THRESHOLD: Record<VadSensitivity, number> = {
	low: 0.06,
	medium: 0.035,
	high: 0.02
};
// Speech must hold above the threshold this long to open the mic, and drop
// below it this long (the end-of-speech setting) to close it.
export const VAD_OPEN_MS = 200;
export const VAD_CLOSE_MS: Record<EndOfSpeech, number> = {
	short: 1200,
	normal: 2000,
	long: 3000
};
// Silence the transcriber must have heard before a finished sentence ends a
// take. A streaming model emits a word up to about 0.9 s after it is said
// (Voxtral Realtime at a 480 ms delay; 0.65 s at 240 ms), so by then the live
// text holds everything said before the pause and can be sent as is.
const SETTLED_MS = 1000;
// Words a sentence doesn't end on: a trailing one means more is coming.
const TRAILING_WORDS = new Set(['and', 'but', 'or', 'so', 'because', 'then', 'um', 'uh', 'er', 'like', 'the', 'a', 'an', 'to', 'of', 'with', 'if', 'that']);

// Whether a live transcript reads as a finished sentence: closing punctuation,
// not a trailing ellipsis, and not stopping on a word that leads into more.
export function looksFinished(text: string): boolean {
	const t = text.trim();
	if (!/[.!?]["')\]]*$/.test(t)) return false;
	if (/(\.\.\.|…)["')\]]*$/.test(t)) return false;
	const last = t.toLowerCase().match(/([a-z']+)[^a-z']*$/)?.[1];
	return !last || !TRAILING_WORDS.has(last);
}

// Whether the live text can end the take now: a finished sentence, followed
// by enough silence that no word can still be on its way.
export function settledTake(text: string, heardSilenceMs: number): boolean {
	return heardSilenceMs >= SETTLED_MS && looksFinished(text);
}
// How much audio from before the detector opened a take starts with.
export const PRE_ROLL_MS = 1000;
// Takes upload as 16 kHz WAV, like the apps', to stay small.
export const TAKE_SAMPLE_RATE = 16_000;
export const RECORDING_MAX_MS = 120_000;
export const RECORDING_MIN_MS = 500;
