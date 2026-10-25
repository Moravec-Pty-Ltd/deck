import { describe, expect, it } from 'vitest';
import { announcement, announcementStale, announcePlays, ANNOUNCE_MS, listeningCuePlays, toolAction, answerAskFlow, askAnswerText, askPrompt, cueSamples, doneCuePlays, skipUtterance, turnEnd, downsample, errorText, isUsableTake, nextSegment, parseVoiceSettings, PcmRing, serializeVoiceSettings, restingCaption, restingStatus, rms, startAskFlow, vadAction, BARGE_IN_HOLD_MS, missedStart, VoiceDetector, wavBytes, workingCuePlays } from './voice-core';
import { VAD_CLOSE_MS, VAD_OPEN_MS } from './speech-core';

describe('voice settings', () => {
	it('defaults and tolerates junk', () => {
		expect(parseVoiceSettings(null)).toEqual({ chattiness: 'every-update', handsFree: true, sensitivity: 'medium', endOfSpeech: 'normal', workingCue: true, announceTools: true, readOut: 'summary' });
		expect(parseVoiceSettings('not json')).toEqual({ chattiness: 'every-update', handsFree: true, sensitivity: 'medium', endOfSpeech: 'normal', workingCue: true, announceTools: true, readOut: 'summary' });
		expect(parseVoiceSettings('{"chattiness":"final-only","handsFree":true,"sensitivity":"high"}')).toEqual({
			chattiness: 'final-only', handsFree: true, sensitivity: 'high', endOfSpeech: 'normal', workingCue: true, announceTools: true, readOut: 'summary'
		});
		expect(parseVoiceSettings('{"workingCue":false}').workingCue).toBe(false);
		expect(parseVoiceSettings('{"announceTools":false}').announceTools).toBe(false);
		expect(parseVoiceSettings('{"readOut":"brief"}').readOut).toBe('brief');
		expect(parseVoiceSettings('{"readOut":"aloud"}').readOut).toBe('summary');
		expect(parseVoiceSettings('{"endOfSpeech":"long"}').endOfSpeech).toBe('long');
		expect(parseVoiceSettings('{"endOfSpeech":"forever"}').endOfSpeech).toBe('normal');
		expect(parseVoiceSettings('{"sensitivity":"loud"}').sensitivity).toBe('medium');
		expect(parseVoiceSettings('{"sensitivity":"high"}').handsFree).toBe(true);
		expect(parseVoiceSettings('{"handsFree":false}').handsFree).toBe(true);
		expect(parseVoiceSettings('{"handsFree":false,"v":2}').handsFree).toBe(false);
		const holdToTalk = { chattiness: 'final-only', handsFree: false, sensitivity: 'low', endOfSpeech: 'short', workingCue: false, announceTools: false, readOut: 'full' } as const;
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
	it('reports when the quiet began, and opens afresh after a reset mid-close', () => {
		const vad = new VoiceDetector(0.05, 200, 2000);
		vad.update(0.2, 0);
		expect(vad.update(0.2, 250)).toBe('start');
		expect(vad.update(0.01, 1000)).toBeNull();
		expect(vad.silentSince).toBe(1000);
		vad.update(0.01, 2000);
		// A take ended early on settled words: without the reset, more speech
		// would only reopen the old take and never start a new one.
		vad.reset();
		expect(vad.update(0.2, 2200)).toBeNull();
		expect(vad.silentSince).toBeNull();
		expect(vad.update(0.2, 2450)).toBe('start');
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
		expect(vadAction('start', false, false, false, null, 0)).toBe('start');
		expect(vadAction('start', true, false, false, null, 0)).toBeNull();
		expect(vadAction('start', false, true, false, null, 0)).toBeNull();
		expect(vadAction('stop', true, false, false, null, 0)).toBe('stop');
		expect(vadAction(null, false, false, false, null, 0)).toBeNull();
	});
	it('cuts off a reply only once speech has held past the barge-in hold', () => {
		const vad = new VoiceDetector(0.05, VAD_OPEN_MS, VAD_CLOSE_MS.normal);
		const at = (level: number, t: number) => vadAction(vad.update(level, t), false, false, true, vad.loudSince, t);
		expect(at(0.1, 1000)).toBeNull();
		expect(at(0.1, 1000 + VAD_OPEN_MS)).toBeNull(); // the take-opening edge alone doesn't stop the reply
		expect(at(0.1, 1000 + BARGE_IN_HOLD_MS)).toBe('start');
		vad.reset();
		expect(at(0.2, 5000)).toBeNull();
		expect(at(0.0, 5050)).toBeNull();
		expect(at(0.0, 5250)).toBeNull(); // a cough, then a pause
		expect(at(0.2, 5300)).toBeNull();
		expect(at(0.2, 5300 + BARGE_IN_HOLD_MS - 1)).toBeNull(); // the hold restarts after the pause
		vad.reset();
		expect(at(0.2, 7000)).toBeNull();
		expect(at(0.0, 7200)).toBeNull();
		expect(at(0.2, 7300)).toBeNull();
		expect(at(0.2, 7000 + BARGE_IN_HOLD_MS)).toBe('start'); // a gap between words keeps the hold
		vad.reset();
		expect(at(0.2, 8000)).toBeNull();
		expect(at(0.2, 8000 + VAD_OPEN_MS)).toBeNull(); // a cough long enough to open the detector
		expect(at(0.0, 8000 + BARGE_IN_HOLD_MS)).toBeNull(); // has ended by the hold
		expect(vadAction(null, false, true, true, 0, 10_000)).toBeNull(); // still transcribing the last take
		expect(vadAction('stop', false, false, true, null, 0)).toBe('stop');
	});
	it('holds speech that opened over a reply until its stop edge', () => {
		expect(missedStart('start', true, false)).toEqual({ edge: 'start', missed: true });
		expect(missedStart(null, true, true)).toEqual({ edge: null, missed: true }); // the reply still plays
		expect(missedStart(null, false, true)).toEqual({ edge: 'start', missed: true }); // the reply ended
		expect(missedStart('stop', false, true)).toEqual({ edge: 'stop', missed: false });
		expect(missedStart('start', false, false)).toEqual({ edge: 'start', missed: false }); // an ordinary start
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

describe('cues', () => {
	it('ticks only while the agent works and nothing else is heard', () => {
		expect(workingCuePlays(true, true, false, false)).toBe(true);
		expect(workingCuePlays(false, true, false, false)).toBe(false);
		expect(workingCuePlays(true, false, false, false)).toBe(false);
		expect(workingCuePlays(true, true, true, false)).toBe(false);
		expect(workingCuePlays(true, true, false, true)).toBe(false);
	});

	it('reads the held final reply at the turn end, else marks it', () => {
		expect(turnEnd('final-only', 'Done.', false)).toEqual({ read: 'Done.', done: false });
		expect(turnEnd('final-only', '', false)).toEqual({ read: null, done: true });
		expect(turnEnd('every-update', '', true)).toEqual({ read: null, done: false });
		expect(turnEnd('every-update', '', false)).toEqual({ read: null, done: true });
	});

	it('marks the end only when no reply was or will be read', () => {
		expect(doneCuePlays(false, false)).toBe(true);
		expect(doneCuePlays(true, false)).toBe(false);
		expect(doneCuePlays(false, true)).toBe(false);
	});

	it('keeps every cue too short and quiet to open a take', () => {
		for (const cue of ['working', 'done', 'listening'] as const) {
			const samples = cueSamples(cue, 48_000);
			expect(samples.length).toBeGreaterThan(0);
			expect((samples.length / 48_000) * 1000).toBeLessThan(VAD_OPEN_MS);
			expect(Math.max(...samples.map(Math.abs))).toBeLessThanOrEqual(0.25);
			expect(Math.abs(samples[0])).toBeLessThan(0.01);
		}
	});
});

describe('listening cue', () => {
	it('plays when hands-free listening resumes with nothing left to read', () => {
		expect(listeningCuePlays('idle', 'listening', false, false)).toBe(true);
		expect(listeningCuePlays('speaking', 'listening', false, false)).toBe(true);
		expect(listeningCuePlays('listening', 'listening', false, false)).toBe(false);
		expect(listeningCuePlays('speaking', 'idle', false, false)).toBe(false);
		expect(listeningCuePlays('transcribing', 'listening', true, false)).toBe(false);
		expect(listeningCuePlays('speaking', 'listening', false, true)).toBe(false);
	});

	it('rises where the done cue falls', () => {
		const pitch = (s: Float32Array, at: number) => {
			let crossings = 0;
			for (let i = at + 1; i < at + 400; i++) if (s[i - 1] < 0 !== s[i] < 0) crossings++;
			return crossings;
		};
		const listening = cueSamples('listening', 16_000);
		const done = cueSamples('done', 16_000);
		expect(pitch(listening, listening.length - 500)).toBeGreaterThan(pitch(listening, 100));
		expect(pitch(done, done.length - 500)).toBeLessThan(pitch(done, 100));
	});
});

describe('tool-call announcements', () => {
	const say = (name: string, input: Record<string, unknown>) => announcement([toolAction(name, input)]);

	it('phrases each tool for speech', () => {
		expect(say('Read', { file_path: '/path/to/project/apps/ios/SessionDetailView.swift' })).toBe('Reading SessionDetailView');
		expect(say('Edit', { file_path: 'src/lib/voice-core.ts' })).toBe('Editing voice-core');
		expect(say('Write', { file_path: 'Makefile' })).toBe('Writing Makefile');
		expect(say('Bash', { command: 'pnpm test --run' })).toBe('Running pnpm test');
		expect(say('Bash', { command: 'cd ~/code/deck && FOO=1 git status --short' })).toBe('Running git status');
		expect(say('Bash', { command: 'sed -n 1,20p file.ts' })).toBe('Running sed');
		expect(say('Bash', { command: 'ls src/lib' })).toBe('Running ls');
		expect(say('Grep', { pattern: 'PasteButton' })).toBe('Searching for PasteButton');
		expect(say('Grep', { pattern: 'paste|Paste.*Handler' })).toBe('Searching for paste Paste Handler');
		expect(say('Grep', { pattern: '\\(' })).toBe('Searching the code');
		expect(say('Glob', { pattern: '**/*.svelte' })).toBe('Finding files');
		expect(say('WebFetch', { url: 'https://www.example.com/docs' })).toBe('Fetching example.com');
		expect(say('WebSearch', { query: 'svelte 5 runes effect cleanup order' })).toBe('Searching the web for svelte 5 runes effect');
		expect(say('Task', { subagent_type: 'review', description: 'Review the diff' })).toBe('Starting a subagent: review');
		expect(say('Agent', { description: 'Find paste handling' })).toBe('Starting a subagent: Find paste handling');
		expect(say('TodoWrite', { todos: [] })).toBe('Updating the to-do list');
		expect(say('mcp__deck__send_message', {})).toBe('Using send message');
		expect(say('ToolSearch', {})).toBe('Using tool search');
		expect(say('mcp__plugin_docs_docs__query_docs', {})).toBe('Using query docs');
		expect(say('Bash', { command: './run.sh --fast' })).toBe('Running run');
		expect(say('Bash', { command: 'cd apps/web' })).toBe('Running a command');
		expect(say('WebSearch', {})).toBe('Searching the web');
	});

	it('merges the newest calls of one kind', () => {
		const read = (f: string) => toolAction('Read', { file_path: f });
		expect(announcement([])).toBeNull();
		expect(announcement([read('a.ts'), read('b.ts'), read('c.ts')])).toBe('Reading three files');
		expect(announcement([toolAction('Bash', { command: 'ls' }), read('a.ts'), read('b.ts')])).toBe('Reading two files');
		expect(announcement([read('a.ts'), read('b.ts'), toolAction('Bash', { command: 'pnpm test' })])).toBe('Running pnpm test');
		expect(announcement([toolAction('Grep', { pattern: 'a' }), toolAction('Glob', { pattern: '*' })])).toBe('Running two searches');
		expect(announcement([toolAction('WebSearch', { query: 'a' }), toolAction('WebFetch', { url: 'https://example.com' })])).toBe('Fetching example.com');
		expect(announcement(Array.from({ length: 12 }, (_, i) => read(`${i}.ts`)))).toBe('Reading 12 files');
	});

	it('plays only into silence, at most once every ANNOUNCE_MS', () => {
		expect(announcePlays(true, true, false, false, ANNOUNCE_MS)).toBe(true);
		expect(announcePlays(true, true, false, false, ANNOUNCE_MS - 1)).toBe(false);
		expect(announcePlays(false, true, false, false, ANNOUNCE_MS)).toBe(false);
		expect(announcePlays(true, false, false, false, ANNOUNCE_MS)).toBe(false);
		expect(announcePlays(true, true, true, false, ANNOUNCE_MS)).toBe(false);
		expect(announcePlays(true, true, false, true, ANNOUNCE_MS)).toBe(false);
	});

	it('drops an announcement once a newer call starts or anything queues behind it', () => {
		const head = { segments: [], toolUseId: 't1' };
		expect(announcementStale(head, 't1', 1)).toBe(false);
		expect(announcementStale(head, 't2', 1)).toBe(true);
		expect(announcementStale(head, null, 1)).toBe(true);
		expect(announcementStale(head, 't1', 2)).toBe(true);
		expect(announcementStale({ segments: [] }, 't2', 2)).toBe(false);
	});
});

describe('skipUtterance', () => {
	const a = { id: 'a', text: '' };
	it('drops the head and a cue waiting behind it, not a real utterance', () => {
		const q1 = [{ segments: [a] }, { segments: [], cue: 'done' as const }, { segments: [a] }];
		skipUtterance(q1);
		expect(q1).toEqual([{ segments: [a] }]);
		const q2 = [{ segments: [a] }, { segments: [], cue: 'done' as const, pending: Promise.resolve([]) }];
		skipUtterance(q2);
		expect(q2).toHaveLength(1);
		const q3 = [{ segments: [], cue: 'done' as const }];
		skipUtterance(q3);
		expect(q3).toEqual([]);
	});
});
