import { describe, expect, it } from 'vitest';
import { answerAskFlow, askAnswerText, askPrompt, downsample, errorText, isUsableTake, nextSegment, parseVoiceSettings, PcmRing, serializeVoiceSettings, restingCaption, restingStatus, rms, startAskFlow, vadAction, VoiceDetector, wavBytes } from './voice-core';
import { VAD_CLOSE_MS, VAD_OPEN_MS } from './speech-core';

describe('voice settings', () => {
	it('defaults and tolerates junk', () => {
		expect(parseVoiceSettings(null)).toEqual({ chattiness: 'every-update', handsFree: true, sensitivity: 'medium', endOfSpeech: 'normal' });
		expect(parseVoiceSettings('not json')).toEqual({ chattiness: 'every-update', handsFree: true, sensitivity: 'medium', endOfSpeech: 'normal' });
		expect(parseVoiceSettings('{"chattiness":"final-only","handsFree":true,"sensitivity":"high"}')).toEqual({
			chattiness: 'final-only', handsFree: true, sensitivity: 'high', endOfSpeech: 'normal'
		});
		expect(parseVoiceSettings('{"endOfSpeech":"long"}').endOfSpeech).toBe('long');
		expect(parseVoiceSettings('{"endOfSpeech":"forever"}').endOfSpeech).toBe('normal');
		expect(parseVoiceSettings('{"sensitivity":"loud"}').sensitivity).toBe('medium');
		expect(parseVoiceSettings('{"sensitivity":"high"}').handsFree).toBe(true);
		expect(parseVoiceSettings('{"handsFree":false}').handsFree).toBe(true);
		expect(parseVoiceSettings('{"handsFree":false,"v":2}').handsFree).toBe(false);
		const holdToTalk = { chattiness: 'final-only', handsFree: false, sensitivity: 'low', endOfSpeech: 'short' } as const;
		expect(parseVoiceSettings(serializeVoiceSettings(holdToTalk))).toEqual(holdToTalk);
	});
});

describe('ask flow', () => {
	const questions = [
		{ question: 'How?', header: 'Approach', options: [{ label: 'Rewrite' }, { label: 'Patch' }] },
		{ question: 'Anything else?' }
	];
	it('reads one question at a time and collects picks and free text', () => {
		let flow = startAskFlow('toolu_1', questions);
		expect(askPrompt(flow)).toBe('Question 1 of 2. How? Options: one, Rewrite. two, Patch.');
		let step = answerAskFlow(flow, 'number two');
		expect(step.done).toBe(false);
		flow = step.flow;
		expect(askPrompt(flow)).toBe('Question 2 of 2. Anything else?');
		step = answerAskFlow(flow, 'No, ship it.');
		expect(step.done).toBe(true);
		expect(step.flow.answers).toEqual([
			{ header: 'Approach', labels: ['Patch'] },
			{ header: 'Anything else?', labels: ['No, ship it.'] }
		]);
		expect(askAnswerText(step.flow)).toBe('Answering your questions:\n- Approach: Patch\n- Anything else?: No, ship it.');
	});
});

describe('voice detector', () => {
	it('opens after sustained speech and closes after silence', () => {
		const vad = new VoiceDetector(0.05, 200, 1200);
		expect(vad.update(0.1, 0)).toBeNull();
		expect(vad.update(0.1, 100)).toBeNull();
		expect(vad.update(0.1, 250)).toBe('start');
		expect(vad.update(0.01, 300)).toBeNull();
		expect(vad.update(0.1, 900)).toBeNull(); // a pause shorter than closeMs keeps the mic open
		expect(vad.update(0.01, 1000)).toBeNull();
		expect(vad.update(0.01, 2100)).toBeNull();
		expect(vad.update(0.01, 2250)).toBe('stop');
		expect(vad.state).toBe('silent');
	});
	it('waits out a 1.5 s pause at the default end of speech, not a 3 s one', () => {
		const run = (pauseMs: number) => {
			const vad = new VoiceDetector(0.05, VAD_OPEN_MS, VAD_CLOSE_MS.normal);
			let edge: string | null = null;
			for (let t = 0; t <= 300; t += 50) vad.update(0.1, t);
			for (let t = 350; t <= 300 + pauseMs; t += 50) edge ??= vad.update(0.01, t);
			return edge;
		};
		expect(run(1500)).toBeNull();
		expect(run(3000)).toBe('stop');
	});
	it('takes a new close delay', () => {
		const vad = new VoiceDetector(0.05, 200, 1200);
		vad.update(0.1, 0);
		vad.update(0.1, 250);
		vad.setCloseMs(3000);
		vad.update(0.01, 300);
		expect(vad.update(0.01, 2000)).toBeNull();
		expect(vad.update(0.01, 3300)).toBe('stop');
	});
	it('ignores a blip shorter than openMs', () => {
		const vad = new VoiceDetector(0.05, 200, 1200);
		expect(vad.update(0.2, 0)).toBeNull();
		expect(vad.update(0.0, 50)).toBeNull();
		expect(vad.state).toBe('silent');
	});
	it('measures level as rms', () => {
		expect(rms([0, 0, 0])).toBe(0);
		expect(rms([0.5, -0.5])).toBeCloseTo(0.5);
		expect(rms([])).toBe(0);
	});
});

describe('take helpers', () => {
	it('keeps only real takes', () => {
		expect(isUsableTake(false, 800, 10, 500)).toBe(true);
		expect(isUsableTake(true, 800, 10, 500)).toBe(false);
		expect(isUsableTake(false, 200, 10, 500)).toBe(false);
		expect(isUsableTake(false, 800, 0, 500)).toBe(false);
	});
	it('keeps the newest chunks covering the pre-roll, oldest first', () => {
		const ring = new PcmRing(4);
		const chunk = (...v: number[]) => new Float32Array(v);
		expect(ring.read()).toEqual([]);
		ring.push(chunk(1, 2));
		ring.push(chunk(3, 4));
		expect(ring.read()).toEqual([chunk(1, 2), chunk(3, 4)]);
		ring.push(chunk(5, 6));
		expect(ring.read()).toEqual([chunk(3, 4), chunk(5, 6)]);
		ring.push(chunk(7, 8, 9, 10, 11));
		expect(ring.read()).toEqual([chunk(7, 8, 9, 10, 11)]);
	});
	it('downsamples by averaging what each output sample covers', () => {
		const out = downsample([new Float32Array([1, 1, 1, 0, 0]), new Float32Array([0, 0.5])], 48_000, 16_000);
		expect([...out]).toEqual([1, 0]);
		expect([...downsample([new Float32Array([0.5]), new Float32Array([0.25])], 16_000, 16_000)]).toEqual([0.5, 0.25]);
		expect(downsample([new Float32Array(48_000)], 48_000, 16_000).length).toBe(16_000);
		expect(downsample([new Float32Array(44_100)], 44_100, 16_000).length).toBe(16_000);
	});
	it('encodes 16-bit mono WAV', () => {
		const bytes = new DataView(wavBytes(new Float32Array([0, 1, -1, 2]), 16_000));
		const tag = (at: number) => String.fromCharCode(...new Uint8Array(bytes.buffer, at, 4));
		expect(bytes.byteLength).toBe(44 + 8);
		expect([tag(0), tag(8), tag(12), tag(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
		expect(bytes.getUint32(24, true)).toBe(16_000);
		expect(bytes.getUint32(40, true)).toBe(8);
		expect([44, 46, 48, 50].map((at) => bytes.getInt16(at, true))).toEqual([0, 32767, -32768, 32767]);
	});
	it('reads an error message or falls back', () => {
		expect(errorText(new Error('boom'), 'x')).toBe('boom');
		expect(errorText('boom', 'x')).toBe('x');
		expect(errorText(new Error(''), 'x')).toBe('x');
	});
});

describe('bar state helpers', () => {
	it('rests in listening only for hands-free while enabled', () => {
		expect(restingStatus(true, true)).toBe('listening');
		expect(restingStatus(true, false)).toBe('idle');
		expect(restingStatus(false, true)).toBe('idle');
	});
	it('clears the transcribing placeholder but keeps a sent transcript', () => {
		expect(restingCaption('idle', 'Transcribing…')).toBe('');
		expect(restingCaption('idle', 'ship it')).toBe('ship it');
		expect(restingCaption('listening', 'Transcribing…')).toBe('Listening…');
		expect(restingCaption('listening', 'ship it')).toBe('ship it');
	});
	it('opens the mic only when free, closes on demand', () => {
		expect(vadAction('start', false, false)).toBe('start');
		expect(vadAction('start', true, false)).toBeNull();
		expect(vadAction('start', false, true)).toBeNull();
		expect(vadAction('stop', true, false)).toBe('stop');
		expect(vadAction(null, false, false)).toBeNull();
	});
	it('prefetches the next segment across utterances', () => {
		const a = { id: 'a', text: '' };
		const b = { id: 'b', text: '' };
		const c = { id: 'c', text: '' };
		expect(nextSegment([{ segments: [a, b] }, { segments: [c] }])).toBe(b);
		expect(nextSegment([{ segments: [a] }, { segments: [c] }])).toBe(c);
		expect(nextSegment([{ segments: [a] }])).toBeUndefined();
	});
});
