import type { SpeechCapabilities, SpeechSegment, SpokenQuestion } from './speech-core';
import { PRE_ROLL_MS, RECORDING_MAX_MS, RECORDING_MIN_MS, TAKE_SAMPLE_RATE, VAD_CLOSE_MS, VAD_OPEN_MS, VAD_THRESHOLD, settledTake } from './speech-core';
import captureWorklet from './pcm-capture.worklet.js?url';
import {
	ACKNOWLEDGEMENTS,
	answerAskFlow,
	askAnswerText,
	askPrompt,
	cueSamples,
	DEFAULT_VOICE_SETTINGS,
	downsample,
	errorText,
	isUsableTake,
	LISTENING_CAPTION,
	nextSegment,
	skipUtterance,
	parseVoiceSettings,
	PcmRing,
	pcm16Bytes,
	serializeVoiceSettings,
	restingCaption,
	restingStatus,
	rms,
	startAskFlow,
	TRANSCRIBING_CAPTION,
	turnEnd,
	vadAction,
	missedStart,
	VoiceDetector,
	wavBytes,
	workingCuePlays,
	WORKING_CUE_MS,
	type AskFlow,
	type Cue,
	type Utterance,
	type VoiceSettings
} from './voice-core';

// Voice mode for one session in the browser: reads replies through deck's
// speech proxy (sentence segments, prefetched one ahead), records push-to-talk
// (or hands-free, energy-gated) audio as PCM from an AudioWorklet and sends
// the transcript on, and walks a blocking question's answers one at a time.
// The capture runs whenever the mic is open, so a take starts with the second
// of audio before the detector opened it and keeps the first word.
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
		localStorage.setItem(SETTINGS_KEY, serializeVoiceSettings(settings));
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

// How often a streamed take sends what it has recorded.
const STREAM_CHUNK_MS = 250;

// Streams one take to deck's transcription relay while it is recorded, so the
// live words can end it; any failure leaves the take to the batch upload.
// Chunks go one request at a time, in order.
class TakeStream {
	private id: Promise<string | null>;
	private pending: Float32Array[];
	private sending: Promise<void> = Promise.resolve();
	private timer: ReturnType<typeof setInterval>;
	private failed = false;
	// Live text the session judged final; the server's final pass is skipped.
	settled: string | null = null;

	constructor(
		lead: Float32Array[],
		private sampleRate: number,
		private onText: (text: string, heardUntil: number) => void
	) {
		this.pending = [...lead];
		this.id = postJson<{ id: string }>('/api/agent/speech/stream', {}).then(
			(r) => r.id,
			() => this.fail()
		);
		this.timer = setInterval(() => this.flush(), STREAM_CHUNK_MS);
	}

	push(chunk: Float32Array): void {
		if (!this.failed) this.pending.push(chunk);
	}

	private flush(): void {
		this.sending = this.sending.then(() => this.sendPending());
	}

	private async sendPending(): Promise<void> {
		const id = await this.id;
		if (!id || !this.pending.length) return;
		const cutAt = Date.now();
		const text = await this.send(`/api/agent/speech/stream/${encodeURIComponent(id)}`);
		if (text !== null) this.onText(text, cutAt);
	}

	// The final transcript, or null when the take must be uploaded instead.
	async end(): Promise<string | null> {
		clearInterval(this.timer);
		await this.sending;
		const id = await this.id;
		if (!id) return this.settled;
		const final = this.send(`/api/agent/speech/stream/${encodeURIComponent(id)}/end`);
		return this.settled ?? final;
	}

	private async send(url: string): Promise<string | null> {
		const pcm = pcm16Bytes(downsample(this.pending, this.sampleRate, TAKE_SAMPLE_RATE));
		this.pending = [];
		try {
			const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'audio/pcm' }, body: pcm });
			if (!res.ok) throw new Error(`stream ${res.status}`);
			return ((await res.json()) as { text: string }).text.trim();
		} catch {
			return this.fail();
		}
	}

	fail(): null {
		this.failed = true;
		this.id = Promise.resolve(null);
		this.pending = [];
		clearInterval(this.timer);
		return null;
	}
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
	// The take's PCM while one is open, starting with the pre-roll.
	private take: Float32Array[] | null = null;
	// The open take's live transcription, when deck has a streaming server.
	private takeStream: TakeStream | null = null;
	// Keeps the screen on while voice mode is on: a hidden tab loses the mic.
	private wakeLock: WakeLockSentinel | 'pending' | null = null;
	private wakeLockRequest = 0;
	// True while a take waits on the mic; a release meanwhile clears it.
	private starting = false;
	private recordStart = 0;
	private recordTimer: ReturnType<typeof setTimeout> | undefined;
	private cancelled = false;
	private context: AudioContext | null = null;
	private captureModule: Promise<void> | null = null;
	private source: MediaStreamAudioSourceNode | null = null;
	private capture: AudioWorkletNode | null = null;
	private ring: PcmRing | null = null;
	private sampleRate = 48_000;
	private detector = new VoiceDetector(VAD_THRESHOLD.medium, VAD_OPEN_MS, VAD_CLOSE_MS.normal);
	// Speech that opened the detector over a reply without cutting it; it
	// becomes a take once the reply ends.
	private startMissed = false;
	// The last assistant text of the turn, read when chattiness is final-only.
	private lastText = '';
	// The session's status is running (set by the view), or a message is on
	// its way to it: what the working cue ticks for.
	turnRunning = false;
	private sending = false;
	private acknowledged = 0;
	// A reply was read during this turn, so its end needs no done cue.
	private replied = false;
	// Cues play on their own element: it never stops a reply, and unlike Web
	// Audio the iPhone's silent switch doesn't mute it.
	private cueAudio: HTMLAudioElement | null = null;
	private cueUrls = new Map<Cue, string>();
	private cueTimer: ReturnType<typeof setInterval> | undefined;

	constructor(private handlers: VoiceHandlers) {}

	get canListen(): boolean {
		return !!this.capabilities?.stt;
	}

	async loadCapabilities(): Promise<SpeechCapabilities | null> {
		try {
			const res = await fetch('/api/agent/speech');
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
		clearInterval(this.cueTimer);
		this.cueTimer = setInterval(() => this.tickWorkingCue(), WORKING_CUE_MS);
		this.warmAcknowledgements();
		document.addEventListener('visibilitychange', this.holdScreen);
		void this.holdScreen();
		if (this.settings.handsFree) await this.startHandsFree();
	}

	// The browser drops the lock whenever the page is hidden, so it is taken
	// again each time the page comes back.
	private holdScreen = async (): Promise<void> => {
		if (!this.wantsScreen) return;
		this.wakeLock = 'pending';
		const request = ++this.wakeLockRequest;
		try {
			this.adoptLock(await navigator.wakeLock.request('screen'));
		} catch {
			// refused (battery saver, no permission): the mic still works while visible
			this.dropRequest(request);
		}
	};

	// Only the newest request may clear the pending mark; a newer one may still land.
	private dropRequest(request: number): void {
		if (request === this.wakeLockRequest && this.wakeLock === 'pending') this.wakeLock = null;
	}

	private adoptLock(lock: WakeLockSentinel): void {
		// Voice mode went off (or another request took over) meanwhile.
		if (this.wakeLock !== 'pending') return void lock.release();
		lock.addEventListener('release', () => {
			if (this.wakeLock === lock) this.wakeLock = null;
		});
		this.wakeLock = lock;
	}

	private get wantsScreen(): boolean {
		return this.enabled && !this.wakeLock && document.visibilityState === 'visible' && !!navigator.wakeLock;
	}

	private releaseScreen(): void {
		document.removeEventListener('visibilitychange', this.holdScreen);
		if (this.wakeLock !== 'pending') void this.wakeLock?.release().catch(() => {});
		this.wakeLock = null;
	}

	// Autoplay refused is fine: real segments still try, and the tap that
	// enabled voice mode usually satisfies the gesture rule anyway.
	private async unlockAudio(): Promise<void> {
		this.audio ??= new Audio();
		this.cueAudio ??= new Audio();
		this.audio.src = SILENT_WAV;
		this.cueAudio.src = SILENT_WAV;
		await Promise.all([this.audio.play().catch(() => {}), this.cueAudio.play().catch(() => {})]);
	}

	disable(): void {
		this.enabled = false;
		clearInterval(this.cueTimer);
		this.releaseScreen();
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
		this.tuneDetector();
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
		else {
			this.replied = true;
			this.speak(markdown, undefined, true);
		}
	}

	onTurnFinished(): void {
		const text = this.lastText;
		const replied = this.replied;
		this.lastText = '';
		this.replied = false;
		if (!this.enabled) return;
		const end = turnEnd(this.settings.chattiness, text, replied);
		// Queued behind what is being read (an acknowledgement) so it waits for
		// it; Skip, Stop and a new take drop it with the queue.
		if (end.done) this.enqueue({ segments: [], cue: 'done' });
		if (end.read) this.speak(end.read, undefined, true);
	}

	// A blocking question arrived: read it and route the next spoken reply to it.
	onAsk(toolUseId: string, questions: SpokenQuestion[]): void {
		if (!this.enabled || !questions.length) return;
		this.ask = startAskFlow(toolUseId, questions);
		this.speak(askPrompt(this.ask), 'done');
	}

	onAskAnswered(toolUseId: string): void {
		if (this.ask?.toolUseId === toolUseId) this.ask = null;
	}

	// `cue` plays just before the first segment, once whatever is ahead of it
	// has been read. The utterance takes its place in the queue now; its
	// segments arrive while earlier ones play. `brief` reads only the opening
	// of a long reply.
	speak(text: string, cue?: Cue, brief = false): void {
		if (!this.enabled) return;
		this.enqueue({ segments: [], cue, pending: this.fetchSegments(text, brief) });
	}

	private enqueue(utterance: Utterance, standalone = false): void {
		this.queue.push(utterance);
		if (!this.playing) void this.drain(standalone);
	}

	// Read one message on request, with voice mode on or off. Off, the audio is
	// unlocked by this click and only this message plays; nothing else changes.
	async readAloud(text: string): Promise<void> {
		if (!this.enabled) {
			await this.unlockAudio();
			this.playToken += 1;
			this.queue = [];
		}
		this.enqueue({ segments: [], pending: this.fetchSegments(text) }, true);
	}

	private async fetchSegments(text: string, brief = false): Promise<SpeechSegment[]> {
		try {
			return (await postJson<{ segments: SpeechSegment[] }>('/api/agent/speech/segments', { text, brief })).segments;
		} catch (e) {
			this.error = errorText(e, 'speech failed');
			return [];
		}
	}

	// Drop the rest of what is being read; the next utterance starts.
	skip(): void {
		if (!this.queue.length) return;
		skipUtterance(this.queue);
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

	// `standalone` keeps playing with voice mode off (a one-off read-aloud).
	private async drain(standalone = false): Promise<void> {
		this.playing = true;
		try {
			while ((this.enabled || standalone) && this.queue.length) await this.playHead();
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
	// superseded by Skip/Stop (token moved on) is dropped unplayed. A head still
	// fetching is waited for; one with nothing to read plays its cue, if any.
	private async playHead(): Promise<void> {
		const head = this.queue[0];
		if (head.pending) return this.fillHead(head, head.pending);
		const segment = head.segments[0];
		if (segment) await this.readSegment(head, segment);
		else await this.playLoneCue(head);
	}

	private async fillHead(head: Utterance, pending: Promise<SpeechSegment[]>): Promise<void> {
		head.segments = await pending;
		head.pending = undefined;
	}

	// Nothing left to read: a done cue on its own, or an utterance read out.
	private async playLoneCue(head: Utterance): Promise<void> {
		if (head.cue) await this.playCue(head.cue);
		if (this.queue[0] === head) this.queue.shift();
	}

	private async readSegment(head: Utterance, segment: SpeechSegment): Promise<void> {
		const token = this.playToken;
		const url = await this.loadSegment(segment.id, token);
		if (!url) return this.finishHead(token);
		this.prefetch(nextSegment(this.queue));
		this.status = 'speaking';
		if (await this.cueBefore(head, token)) {
			this.caption = segment.text;
			await this.play(url, token);
		}
		URL.revokeObjectURL(url);
		this.finishHead(token);
	}

	// The head's cue, just before its first segment; false when Skip/Stop
	// landed during it.
	private async cueBefore(head: Utterance, token: number): Promise<boolean> {
		const cue = head.cue;
		if (!cue) return true;
		head.cue = undefined;
		await this.playCue(cue);
		return token === this.playToken;
	}

	// Advance past the head segment, unless Skip/Stop already replaced the queue.
	private finishHead(token: number): void {
		if (token === this.playToken) this.queue[0]?.segments.shift();
	}

	private async loadSegment(id: string, token: number): Promise<string | null> {
		try {
			const res = await fetch(`/api/agent/speech/audio/${encodeURIComponent(id)}`);
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
		if (next) void fetch(`/api/agent/speech/audio/${encodeURIComponent(next.id)}`).catch(() => {});
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

	// ---- Cues ----

	// Recording, transcribing, reading, or with something queued to read.
	private get busy(): boolean {
		return this.recording || this.status === 'transcribing' || this.playing || this.queue.length > 0;
	}

	private tickWorkingCue(): void {
		const working = this.turnRunning || this.sending;
		if (workingCuePlays(this.settings.workingCue, working, !!this.ask, this.busy)) void this.playCue('working');
	}

	private playCue(cue: Cue): Promise<void> {
		const audio = this.cueAudio;
		if (!audio) return Promise.resolve();
		let url = this.cueUrls.get(cue);
		if (!url) {
			url = URL.createObjectURL(new Blob([wavBytes(cueSamples(cue, TAKE_SAMPLE_RATE), TAKE_SAMPLE_RATE)], { type: 'audio/wav' }));
			this.cueUrls.set(cue, url);
		}
		// The timer stands in for an `ended` that never comes (playback refused).
		return new Promise((resolve) => {
			const timer = setTimeout(resolve, 500);
			audio.onended = audio.onerror = () => (clearTimeout(timer), resolve());
			audio.src = url;
			audio.play().catch(() => {});
		});
	}

	// Say a take was heard, in the reply's voice.
	private acknowledge(): void {
		this.speak(ACKNOWLEDGEMENTS[this.acknowledged++ % ACKNOWLEDGEMENTS.length]);
	}

	// Synthesise the acknowledgements up front so the first one plays at once.
	private warmAcknowledgements(): void {
		for (const text of ACKNOWLEDGEMENTS) {
			postJson<{ segments: SpeechSegment[] }>('/api/agent/speech/segments', { text }).then(
				(r) => r.segments.forEach((s) => this.prefetch(s)),
				() => {}
			);
		}
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
		if (!this.enabled || this.micBusy) return;
		this.error = '';
		this.startMissed = false;
		this.stopPlayback();
		this.starting = true;
		try {
			await this.openTake();
		} catch (e) {
			this.error = errorText(e, 'microphone unavailable');
			this.status = 'idle';
		}
		this.starting = false;
	}

	// A take is open or on its way.
	private get micBusy(): boolean {
		return !!this.take || this.starting;
	}

	// Released (or the mic closed) while it was starting: no take, and
	// hold-to-talk closes the mic.
	private async openTake(): Promise<void> {
		await this.startCapture(await this.openMic());
		if (this.starting && this.capture) this.beginTake();
		else this.releaseMic();
	}

	private beginTake(): void {
		this.take = this.ring?.read() ?? [];
		if (this.capabilities?.stream) {
			const stream: TakeStream = new TakeStream(this.take, this.sampleRate, (text, heardUntil) => this.onLiveText(stream, text, heardUntil));
			this.takeStream = stream;
		}
		this.cancelled = false;
		this.recording = true;
		this.recordStart = Date.now();
		this.status = 'listening';
		this.caption = LISTENING_CAPTION;
		this.recordTimer = setTimeout(() => this.stopRecording(), RECORDING_MAX_MS);
	}

	// While the take is open, show the words so far. Hands-free, a finished
	// sentence the transcriber heard enough silence after ends the take there,
	// with its text, rather than waiting out the end-of-speech pause.
	private onLiveText(stream: TakeStream, text: string, heardUntil: number): void {
		if (stream !== this.takeStream) return;
		this.caption = text || LISTENING_CAPTION;
		if (!this.settles(text, heardUntil)) return;
		stream.settled = text;
		this.stopRecording();
		// The detector is mid-close; reset it so the next words open a new take.
		this.detector.reset();
	}

	private settles(text: string, heardUntil: number): boolean {
		const quiet = this.detector.silentSince;
		return this.settings.handsFree && quiet !== null && settledTake(text, heardUntil - quiet);
	}

	stopRecording(): void {
		clearTimeout(this.recordTimer);
		const take = this.take;
		const stream = this.takeStream;
		this.starting = false;
		if (!take) return;
		this.take = null;
		this.takeStream = null;
		this.recording = false;
		// The clock starts with the take, so the pre-roll is not counted.
		const ms = Date.now() - this.recordStart;
		this.releaseMic();
		void this.finishTake(take, this.sampleRate, ms, stream);
	}

	// Hold-to-talk closes the mic between takes; hands-free keeps it listening.
	private releaseMic(): void {
		if (this.settings.handsFree) return;
		this.stopCapture();
		this.closeMic();
	}

	cancelRecording(): void {
		this.cancelled = true;
		this.stopRecording();
		if (this.status === 'listening') this.status = 'idle';
		this.caption = '';
	}

	private async finishTake(take: Float32Array[], sampleRate: number, ms: number, stream: TakeStream | null): Promise<void> {
		const frames = take.reduce((n, c) => n + c.length, 0);
		if (!isUsableTake(this.cancelled, ms, frames, RECORDING_MIN_MS)) {
			stream?.fail();
			this.restAfterTake();
			return;
		}
		this.status = 'transcribing';
		this.caption = TRANSCRIBING_CAPTION;
		try {
			const streamed = await stream?.end();
			await this.deliver(streamed ?? (await this.transcribe(new Blob([wavBytes(downsample(take, sampleRate, TAKE_SAMPLE_RATE), TAKE_SAMPLE_RATE)], { type: 'audio/wav' }))));
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
		const res = await fetch('/api/agent/speech/transcribe', { method: 'POST', headers: { 'content-type': blob.type }, body: blob });
		if (res.status === 413) throw new Error('recording too large for the server (raise BODY_SIZE_LIMIT)');
		if (!res.ok) throw new Error(`transcribe ${res.status}`);
		return ((await res.json()) as { text: string }).text.trim();
	}

	// A transcript answers the open question when there is one, else it is a
	// message to the session. Silence (an empty transcript) goes nowhere.
	private async deliver(text: string): Promise<void> {
		this.caption = text;
		if (!text) return;
		this.sending = true;
		this.acknowledge();
		try {
			if (this.ask) await this.answerStep(this.ask, text);
			else await this.handlers.send(text);
		} finally {
			this.sending = false;
		}
	}

	// One question answered; read the next, or post the finished set.
	private async answerStep(ask: AskFlow, text: string): Promise<void> {
		const step = answerAskFlow(ask, text);
		this.ask = step.done ? null : step.flow;
		if (step.done) await this.handlers.answer(step.flow.toolUseId, askAnswerText(step.flow), step.flow.answers);
		else this.speak(askPrompt(step.flow));
	}

	// ---- Capture, level meter and hands-free detector ----

	// Mic PCM flows through the worklet for as long as the mic is open: into the
	// pre-roll ring always, into the take while one is open.
	private async startCapture(stream: MediaStream): Promise<void> {
		const context = this.runningContext();
		if (this.capture) return;
		await this.loadCaptureModule(context);
		// Started by another call meanwhile, or the mic closed while loading.
		if (this.capture || stream !== this.stream) return;
		const source = context.createMediaStreamSource(stream);
		const capture = new AudioWorkletNode(context, 'pcm-capture');
		capture.port.onmessage = (e: MessageEvent<Float32Array>) => this.onPcm(e.data);
		source.connect(capture);
		// The output is silence; connecting it keeps the node processing everywhere.
		capture.connect(context.destination);
		this.sampleRate = context.sampleRate;
		this.ring = new PcmRing(Math.round((context.sampleRate * PRE_ROLL_MS) / 1000));
		this.source = source;
		this.capture = capture;
	}

	// A context the system suspended (an interruption) delivers nothing, so
	// every start asks it to run.
	private runningContext(): AudioContext {
		const context = (this.context ??= new AudioContext());
		void context.resume().catch(() => {});
		return context;
	}

	// Once per context; a failed load is retried on the next take.
	private loadCaptureModule(context: AudioContext): Promise<void> {
		return (this.captureModule ??= context.audioWorklet.addModule(captureWorklet).catch((e) => {
			this.captureModule = null;
			throw e;
		}));
	}

	private stopCapture(): void {
		this.capture?.port.postMessage('stop');
		if (this.capture) this.capture.port.onmessage = null;
		this.capture?.disconnect();
		this.source?.disconnect();
		this.capture = null;
		this.source = null;
		this.ring = null;
		this.level = 0;
	}

	private onPcm(chunk: Float32Array): void {
		this.take?.push(chunk);
		this.takeStream?.push(chunk);
		this.ring?.push(chunk);
		const level = rms(chunk);
		this.level = Math.min(1, level * 6);
		if (this.settings.handsFree) this.onLevel(level);
	}

	private tuneDetector(): void {
		this.detector.setThreshold(VAD_THRESHOLD[this.settings.sensitivity]);
		this.detector.setCloseMs(VAD_CLOSE_MS[this.settings.endOfSpeech]);
	}

	private async startHandsFree(): Promise<void> {
		if (!this.enabled || !this.canListen) return;
		try {
			const stream = await this.openMic();
			this.tuneDetector();
			this.detector.reset();
			this.startMissed = false;
			await this.startCapture(stream);
			this.restAfterTake();
		} catch (e) {
			this.error = errorText(e, 'microphone unavailable');
		}
	}

	private stopHandsFree(): void {
		this.detector.reset();
		this.startMissed = false;
		if (!this.take) {
			this.stopCapture();
			this.closeMic();
		}
		if (this.status !== 'listening') return;
		this.status = 'idle';
		this.caption = '';
	}

	// The detector's edges open and close takes in hands-free mode; a take that
	// is still transcribing keeps the mic closed.
	private onLevel(level: number): void {
		const now = Date.now();
		const edge = this.detector.update(level, now);
		const speaking = this.status === 'speaking';
		const pending = missedStart(edge, speaking, this.startMissed);
		this.startMissed = pending.missed;
		const action = vadAction(pending.edge, this.recording, this.status === 'transcribing', speaking, this.detector.loudSince, now);
		if (action === 'start') void this.startRecording();
		if (action === 'stop') this.stopRecording();
	}

	destroy(): void {
		this.disable();
		this.context?.close().catch(() => {});
		this.context = null;
		this.captureModule = null;
	}
}
