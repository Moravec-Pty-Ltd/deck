// Pure logic for voice mode, shared by the server (what to synthesise) and the
// web client (what to do with a spoken reply). Node-free so it unit-tests
// without a speech server; the fetches live in server/speech.ts.

export interface SpeechCapabilities {
	// Whether a text-to-speech / speech-to-text server is configured and up.
	tts: boolean;
	stt: boolean;
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
export type VadSensitivity = 'low' | 'medium' | 'high';

// RMS thresholds (0..1 amplitude) for the energy detector, per sensitivity.
// High opens on quieter speech and so also on more room noise.
export const VAD_THRESHOLD: Record<VadSensitivity, number> = {
	low: 0.06,
	medium: 0.035,
	high: 0.02
};
// Speech must hold above the threshold this long to open the mic, and drop
// below it this long to close it.
export const VAD_OPEN_MS = 200;
export const VAD_CLOSE_MS = 1200;
export const RECORDING_MAX_MS = 120_000;
export const RECORDING_MIN_MS = 500;
