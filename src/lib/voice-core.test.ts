import { describe, expect, it } from 'vitest';
import { answerAskFlow, askAnswerText, askPrompt, errorText, isUsableTake, nextSegment, parseVoiceSettings, pickRecorderType, restingCaption, restingStatus, rms, startAskFlow, vadAction, VoiceDetector } from './voice-core';

describe('voice settings', () => {
	it('defaults and tolerates junk', () => {
		expect(parseVoiceSettings(null)).toEqual({ chattiness: 'every-update', handsFree: false, sensitivity: 'medium' });
		expect(parseVoiceSettings('not json')).toEqual({ chattiness: 'every-update', handsFree: false, sensitivity: 'medium' });
		expect(parseVoiceSettings('{"chattiness":"final-only","handsFree":true,"sensitivity":"high"}')).toEqual({
			chattiness: 'final-only', handsFree: true, sensitivity: 'high'
		});
		expect(parseVoiceSettings('{"sensitivity":"loud"}').sensitivity).toBe('medium');
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

describe('take and recorder helpers', () => {
	it('keeps only real takes', () => {
		expect(isUsableTake(false, 800, 10, 500)).toBe(true);
		expect(isUsableTake(true, 800, 10, 500)).toBe(false);
		expect(isUsableTake(false, 200, 10, 500)).toBe(false);
		expect(isUsableTake(false, 800, 0, 500)).toBe(false);
	});
	it('prefers opus webm, then mp4, else leaves the choice to the browser', () => {
		expect(pickRecorderType((t) => t === 'audio/mp4')).toBe('audio/mp4');
		expect(pickRecorderType(() => true)).toBe('audio/webm;codecs=opus');
		expect(pickRecorderType(() => false)).toBeUndefined();
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
