import type { SpeechCapabilities, SpeechSegment, SpokenQuestion } from './speech-core';
import { RECORDING_MAX_MS, RECORDING_MIN_MS, VAD_CLOSE_MS, VAD_OPEN_MS, VAD_THRESHOLD } from './speech-core';
import {
	answerAskFlow,
	askAnswerText,
	askPrompt,
	DEFAULT_VOICE_SETTINGS,
	errorText,
	isUsableTake,
	LISTENING_CAPTION,
	nextSegment,
	parseVoiceSettings,
	pickRecorderType,
	restingCaption,
	restingStatus,
	rms,
	startAskFlow,
	TRANSCRIBING_CAPTION,
	vadAction,
	VoiceDetector,
	type AskFlow,
	type Utterance,
	type VoiceSettings
} from './voice-core';

// Voice mode for one session in the browser: reads replies through deck's
// speech proxy (sentence segments, prefetched one ahead), records push-to-talk
// (or hands-free, energy-gated) audio through the MediaRecorder and sends the
// transcript on, and walks a blocking question's answers one at a time.
// Everything reactive is a rune so the bar renders straight off it; the pure
// pieces are in voice-core.ts, which is where the branching is tested.

const SETTINGS_KEY = 'deck:voice';
// One WAV sample of silence: Safari only lets a page play audio after a
// gesture, so the first play happens inside the enable tap.
const SILENT_WAV =
	'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQIAAAAAAA==';

type VoiceStatus = 'idle' | 'speaking' | 'listening' | 'transcribing';

export interface VoiceHandlers {
	// Send a spoken message to the session.
	send: (text: string) => Promise<void>;
	// Post a completed question answer (same contract as the ask card).
	answer: (toolUseId: string, text: string, answers: { header: string; labels: string[] }[]) => Promise<void>;
	// Interrupt the running turn (the Stop button).
	interrupt: () => Promise<void>;
}

function loadVoiceSettings(): VoiceSettings {
	if (typeof localStorage === 'undefined') return DEFAULT_VOICE_SETTINGS;
	return parseVoiceSettings(localStorage.getItem(SETTINGS_KEY));
}

function saveVoiceSettings(settings: VoiceSettings): void {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
	} catch {
		// private mode / quota: keep the in-memory value
	}
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	if (!res.ok) throw new Error(`${url.split('/').pop()} ${res.status}`);
	return (await res.json()) as T;
}

export class VoiceSession {
	enabled = $state(false);
	status = $state<VoiceStatus>('idle');
	// The sentence being read, or the transcript just sent.
	caption = $state('');
	error = $state('');
	// Mic level 0..1 while recording, for the button's ring.
	level = $state(0);
	// True while a take is being captured (hands-free listening without speech
	// is not recording).
	recording = $state(false);
	settings = $state<VoiceSettings>(loadVoiceSettings());
	capabilities = $state<SpeechCapabilities | null>(null);
	ask = $state<AskFlow | null>(null);

	private queue: Utterance[] = [];
	private audio: HTMLAudioElement | null = null;
	private playing = false;
	private playToken = 0;
	private stream: MediaStream | null = null;
	private recorder: MediaRecorder | null = null;
	private chunks: BlobPart[] = [];
	private recordStart = 0;
	private recordTimer: ReturnType<typeof setTimeout> | undefined;
	private cancelled = false;
	private context: AudioContext | null = null;
	private analyser: AnalyserNode | null = null;
	private meterTimer: ReturnType<typeof setInterval> | undefined;
	private detector = new VoiceDetector(VAD_THRESHOLD.medium, VAD_OPEN_MS, VAD_CLOSE_MS);
	// The last assistant text of the turn, read when chattiness is final-only.
	private lastText = '';

	constructor(private handlers: VoiceHandlers) {}

	get canListen(): boolean {
		return !!this.capabilities?.stt;
	}

	async loadCapabilities(): Promise<SpeechCapabilities | null> {
		try {
			const res = await fetch('/api/speech');
			if (res.ok) this.capabilities = (await res.json()) as SpeechCapabilities;
		} catch {
			this.capabilities = null;
		}
		return this.capabilities;
	}

	// ---- On / off ----

	async enable(): Promise<void> {
		if (this.enabled) return;
		this.error = '';
		await this.unlockAudio();
		this.enabled = true;
		if (this.settings.handsFree) await this.startHandsFree();
	}

	// Autoplay refused is fine: real segments still try, and the tap that
	// enabled voice mode usually satisfies the gesture rule anyway.
	private async unlockAudio(): Promise<void> {
		this.audio ??= new Audio();
		this.audio.src = SILENT_WAV;
		await this.audio.play().catch(() => {});
	}

	disable(): void {
		this.enabled = false;
		this.stopPlayback();
		this.cancelRecording();
		this.stopHandsFree();
		this.ask = null;
		this.caption = '';
		this.status = 'idle';
	}

	updateSettings(next: VoiceSettings): void {
		this.settings = next;
		saveVoiceSettings(next);
		this.detector.setThreshold(VAD_THRESHOLD[next.sensitivity]);
		if (!this.enabled) return;
		if (next.handsFree) void this.startHandsFree();
		else this.stopHandsFree();
	}

	// ---- Reading ----

	// A new assistant text block landed. Read it now, or hold it for the turn's
	// end when only the final reply is wanted.
	onAssistantText(markdown: string): void {
		if (!this.enabled) return;
		if (this.settings.chattiness === 'final-only') this.lastText = markdown;
		else void this.speak(markdown);
	}

	onTurnFinished(): void {
		const text = this.lastText;
		this.lastText = '';
		if (this.enabled && this.settings.chattiness === 'final-only' && text) void this.speak(text);
	}

	// A blocking question arrived: read it and route the next spoken reply to it.
	onAsk(toolUseId: string, questions: SpokenQuestion[]): void {
		if (!this.enabled || !questions.length) return;
		this.ask = startAskFlow(toolUseId, questions);
		void this.speak(askPrompt(this.ask));
	}

	onAskAnswered(toolUseId: string): void {
		if (this.ask?.toolUseId === toolUseId) this.ask = null;
	}

	async speak(text: string): Promise<void> {
		const segments = await this.fetchSegments(text);
		if (!segments.length || !this.enabled) return;
		this.queue.push({ segments });
		if (!this.playing) void this.drain();
	}

	private async fetchSegments(text: string): Promise<SpeechSegment[]> {
		try {
			return (await postJson<{ segments: SpeechSegment[] }>('/api/speech/segments', { text })).segments;
		} catch (e) {
			this.error = errorText(e, 'speech failed');
			return [];
		}
	}

	// Drop the rest of what is being read; the next utterance starts.
	skip(): void {
		if (!this.queue.length) return;
		this.queue.shift();
		this.playToken += 1;
		this.audio?.pause();
	}

	// Stop reading and interrupt the turn.
	async stop(): Promise<void> {
		this.stopPlayback();
		await this.handlers.interrupt();
	}

	private stopPlayback(): void {
		this.queue = [];
		this.playToken += 1;
		this.audio?.pause();
		this.audio?.removeAttribute('src');
		this.caption = '';
		if (this.status === 'speaking') this.restAfterTake();
	}

	private async drain(): Promise<void> {
		this.playing = true;
		try {
			while (this.enabled && this.queue.length) await this.playHead();
		} finally {
			this.playing = false;
			this.settleAfterPlayback();
		}
	}

	private settleAfterPlayback(): void {
		this.caption = '';
		if (this.status === 'speaking') this.restAfterTake();
	}

	// Play the queue's head segment; a segment that fails to load is skipped, one
	// superseded by Skip/Stop (token moved on) is dropped unplayed.
	private async playHead(): Promise<void> {
		const segment = this.headSegment();
		if (!segment) return;
		const token = this.playToken;
		const url = await this.loadSegment(segment.id, token);
		if (!url) {
			this.finishHead(token);
			return;
		}
		this.prefetch(nextSegment(this.queue));
		this.status = 'speaking';
		this.caption = segment.text;
		await this.play(url, token);
		URL.revokeObjectURL(url);
		this.finishHead(token);
	}

	// The segment at the front of the queue, dropping an emptied utterance.
	private headSegment(): SpeechSegment | undefined {
		const segment = this.queue[0]?.segments[0];
		if (!segment) this.queue.shift();
		return segment;
	}

	// Advance past the head segment, unless Skip/Stop already replaced the queue.
	private finishHead(token: number): void {
		if (token === this.playToken) this.queue[0]?.segments.shift();
	}

	private async loadSegment(id: string, token: number): Promise<string | null> {
		try {
			const res = await fetch(`/api/speech/audio/${encodeURIComponent(id)}`);
			if (!res.ok) throw new Error(`audio ${res.status}`);
			const url = URL.createObjectURL(await res.blob());
			if (token === this.playToken) return url;
			URL.revokeObjectURL(url);
		} catch (e) {
			this.error = errorText(e, 'audio failed');
		}
		return null;
	}

	// Warm the browser cache for the next segment while this one plays.
	private prefetch(next: { id: string } | undefined): void {
		if (next) void fetch(`/api/speech/audio/${encodeURIComponent(next.id)}`).catch(() => {});
	}

	private play(url: string, token: number): Promise<void> {
		const audio = (this.audio ??= new Audio());
		return new Promise((resolve) => {
			const done = () => {
				audio.onended = null;
				audio.onerror = null;
				audio.onpause = null;
				resolve();
			};
			audio.onended = done;
			audio.onerror = done;
			audio.onpause = () => {
				if (token !== this.playToken) done();
			};
			audio.src = url;
			audio.play().catch(done);
		});
	}

	// ---- Talking ----

	private async openMic(): Promise<MediaStream> {
		this.stream ??= await navigator.mediaDevices.getUserMedia({
			audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
		});
		return this.stream;
	}

	private closeMic(): void {
		this.stream?.getTracks().forEach((t) => t.stop());
		this.stream = null;
	}

	// Hold-to-talk began (or the detector opened). Reading stops: the reply
	// supersedes it.
	async startRecording(): Promise<void> {
		if (!this.enabled || this.recorder) return;
		this.error = '';
		this.stopPlayback();
		try {
			const stream = await this.openMic();
			this.beginTake(stream);
		} catch (e) {
			this.error = errorText(e, 'microphone unavailable');
			this.status = 'idle';
		}
	}

	private beginTake(stream: MediaStream): void {
		const type = pickRecorderType((t) => MediaRecorder.isTypeSupported(t));
		const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
		this.chunks = [];
		this.cancelled = false;
		recorder.ondataavailable = (e) => {
			if (e.data.size) this.chunks.push(e.data);
		};
		recorder.onstop = () => void this.finishTake(recorder.mimeType || type || 'audio/webm');
		recorder.start(250);
		this.recorder = recorder;
		this.recording = true;
		this.recordStart = Date.now();
		this.status = 'listening';
		this.caption = LISTENING_CAPTION;
		this.recordTimer = setTimeout(() => this.stopRecording(), RECORDING_MAX_MS);
		this.startMeter(stream);
	}

	stopRecording(): void {
		clearTimeout(this.recordTimer);
		const recorder = this.recorder;
		if (!recorder) return;
		this.recorder = null;
		this.recording = false;
		if (recorder.state !== 'inactive') recorder.stop();
		if (this.settings.handsFree) return;
		this.stopMeter();
		this.closeMic();
	}

	cancelRecording(): void {
		this.cancelled = true;
		this.stopRecording();
		if (this.status === 'listening') this.status = 'idle';
		this.caption = '';
	}

	private async finishTake(type: string): Promise<void> {
		const blob = new Blob(this.chunks, { type });
		this.chunks = [];
		if (!isUsableTake(this.cancelled, Date.now() - this.recordStart, blob.size, RECORDING_MIN_MS)) {
			this.restAfterTake();
			return;
		}
		this.status = 'transcribing';
		this.caption = TRANSCRIBING_CAPTION;
		try {
			await this.deliver(await this.transcribe(blob));
		} catch (e) {
			this.error = errorText(e, 'transcription failed');
		}
		this.restAfterTake();
	}

	private restAfterTake(): void {
		this.status = restingStatus(this.settings.handsFree, this.enabled);
		this.caption = restingCaption(this.status, this.caption);
	}

	private async transcribe(blob: Blob): Promise<string> {
		const res = await fetch('/api/speech/transcribe', { method: 'POST', headers: { 'content-type': blob.type }, body: blob });
		if (!res.ok) throw new Error(`transcribe ${res.status}`);
		return ((await res.json()) as { text: string }).text.trim();
	}

	// A transcript answers the open question when there is one, else it is a
	// message to the session. Silence (an empty transcript) goes nowhere.
	private async deliver(text: string): Promise<void> {
		this.caption = text;
		if (!text) return;
		if (this.ask) await this.answerStep(this.ask, text);
		else await this.handlers.send(text);
	}

	// One question answered; read the next, or post the finished set.
	private async answerStep(ask: AskFlow, text: string): Promise<void> {
		const step = answerAskFlow(ask, text);
		this.ask = step.done ? null : step.flow;
		if (step.done) await this.handlers.answer(step.flow.toolUseId, askAnswerText(step.flow), step.flow.answers);
		else void this.speak(askPrompt(step.flow));
	}

	// ---- Level meter and hands-free detector ----

	private startMeter(stream: MediaStream): void {
		if (this.meterTimer) return;
		const analyser = this.attachAnalyser(stream);
		if (!analyser) return;
		const buffer = new Float32Array(analyser.fftSize);
		this.meterTimer = setInterval(() => {
			analyser.getFloatTimeDomainData(buffer);
			const level = rms(buffer);
			this.level = Math.min(1, level * 6);
			if (this.settings.handsFree) this.onLevel(level);
		}, 50);
	}

	private attachAnalyser(stream: MediaStream): AnalyserNode | null {
		try {
			this.context ??= new AudioContext();
			const analyser = this.context.createAnalyser();
			analyser.fftSize = 1024;
			this.context.createMediaStreamSource(stream).connect(analyser);
			this.analyser = analyser;
			return analyser;
		} catch {
			return null;
		}
	}

	private stopMeter(): void {
		clearInterval(this.meterTimer);
		this.meterTimer = undefined;
		this.analyser?.disconnect();
		this.analyser = null;
		this.level = 0;
	}

	private async startHandsFree(): Promise<void> {
		if (!this.enabled || !this.canListen) return;
		try {
			const stream = await this.openMic();
			this.detector.setThreshold(VAD_THRESHOLD[this.settings.sensitivity]);
			this.detector.reset();
			this.startMeter(stream);
			this.restAfterTake();
		} catch (e) {
			this.error = errorText(e, 'microphone unavailable');
		}
	}

	private stopHandsFree(): void {
		this.stopMeter();
		this.detector.reset();
		if (!this.recorder) this.closeMic();
		if (this.status !== 'listening') return;
		this.status = 'idle';
		this.caption = '';
	}

	// The detector's edges drive the recorder in hands-free mode; a take that
	// is still transcribing keeps the mic closed.
	private onLevel(level: number): void {
		const action = vadAction(this.detector.update(level, Date.now()), this.recording, this.status === 'transcribing');
		if (action === 'start') void this.startRecording();
		if (action === 'stop') this.stopRecording();
	}

	destroy(): void {
		this.disable();
		this.context?.close().catch(() => {});
		this.context = null;
	}
}
