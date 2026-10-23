#if os(iOS) || os(watchOS) || os(macOS)
import AVFoundation
import Foundation
import Observation

// Voice mode for one session: reads replies through deck's speech proxy
// (sentence segments, prefetched one ahead), captures push-to-talk or
// hands-free takes, sends the transcript on, and walks a blocking question's
// answers one at a time. The phone captures through an AVAudioEngine tap (so
// hands-free can watch the level before a take starts); the watch records
// with AVAudioRecorder and has no hands-free. The Mac has no AVAudioSession:
// it captures through the same engine tap with voice processing on (its echo
// cancellation) and plays straight to the default output.

public enum VoiceError: LocalizedError {
	case microphoneUnavailable
	case microphoneDenied

	public var errorDescription: String? {
		switch self {
		case .microphoneUnavailable: return "No microphone is available."
		case .microphoneDenied: return "Microphone access is off for deck in \(AppPlatform.current.microphoneSetting)."
		}
	}
}

/// What the controller needs from the screen that owns it.
public struct VoiceHandlers: Sendable {
	public var send: @Sendable (String) async throws -> Void
	public var answer: @Sendable (DeckAsk, AskAnswerDraft) async throws -> Void
	public var interrupt: @Sendable () async throws -> Void

	public init(
		send: @escaping @Sendable (String) async throws -> Void,
		answer: @escaping @Sendable (DeckAsk, AskAnswerDraft) async throws -> Void,
		interrupt: @escaping @Sendable () async throws -> Void
	) {
		self.send = send
		self.answer = answer
		self.interrupt = interrupt
	}
}

@MainActor
@Observable
public final class VoiceController {
	public enum Status: Sendable { case idle, speaking, listening, transcribing }

	public private(set) var enabled = false
	public private(set) var status: Status = .idle
	/// The sentence being read, or the transcript just sent.
	public private(set) var caption = ""
	public private(set) var error: String?
	/// Mic level 0..1 while capturing, for the button's ring.
	public private(set) var level: Float = 0
	/// True while a take is being captured (hands-free listening without
	/// speech is not recording).
	public private(set) var recording = false
	public private(set) var capabilities: SpeechCapabilities?
	public private(set) var ask: VoiceAskFlow?
	/// Where playback is going right now ("Speaker", "AirPods"), from the audio
	/// session's route, so a silent phone is explained at a glance.
	public private(set) var outputRoute = ""
	public var settings: VoiceSettings {
		didSet { applySettings() }
	}
	/// Hands-free takes start only while this is true; the operator keeps the
	/// mic monitoring for its wake word but records only once it has heard it.
	public var listenGate = true
	/// Whether settings changes are written to the device's shared voice
	/// settings; the operator forces hands-free on for itself without changing
	/// what a session's voice mode does.
	public var persistsSettings = true
	/// Whether a sent take is acknowledged aloud ("Got it."); the operator's
	/// own reply is its acknowledgement.
	public var acknowledges = true
	/// Called when the queue of speech has drained, for a follow-up window.
	public var onPlaybackFinished: (() -> Void)?
	private var transcript = ""
	private var wordsAt: TimeInterval?
	#if os(iOS)
	/// Every captured audio buffer, on the audio thread, while the mic is
	/// monitoring: a wake-word recogniser reads the same tap as the recorder.
	public var onAudioBuffer: ((AVAudioPCMBuffer) -> Void)? {
		didSet { (capture as? EngineCapture)?.onBuffer = onAudioBuffer }
	}
	#endif

	public let sessionId: String
	private let client: DeckClient
	private let handlers: VoiceHandlers
	private let player = SpeechPlayer()
	// A silent loop that keeps the audio session (and so the app, behind the
	// lock screen) alive between replies, since the next reply can arrive
	// minutes later and only a live stream can hear it.
	private var keepAlive: AVAudioPlayer?
	private let capture: TakeCapture
	private var queue: [Utterance] = []
	private var playing = false
	private var playToken = 0
	private var prefetched: [String: Task<Data, Error>] = [:]
	private var detector = VoiceDetector(threshold: VadSensitivity.medium.threshold)
	// Speech that opened the detector over a reply without cutting it; it
	// becomes a take once the reply ends.
	private var startMissed = false
	private var takeTimer: Task<Void, Never>?
	private var cancelled = false
	private var lastText = ""
	/// The session's status is running, set by the screen following its
	/// stream; with a message on its way, what the working cue ticks for.
	public var turnRunning = false
	private var sending = false
	private var acknowledged = 0
	// A reply was read during this turn, so its end needs no done cue.
	private var replied = false
	private var cueLoop: Task<Void, Never>?
	private var cuePlayer: AVAudioPlayer?
	private var awaitingPermission = false
	// The open take's live transcription, while it is answering; nil falls
	// back to uploading the whole take when it ends.
	private var streamId: String?
	private var streamLoop: Task<Void, Never>?
	private var streamSend: Task<Bool, Never>?
	// Live text that ended the take; sent without the server's final pass.
	private var settledText: String?
	#if os(macOS)
	private var activity: NSObjectProtocol?
	#endif

	private var micPermitted: Bool { MicrophoneAccess.granted }

	// Ask once; the take that triggered it starts as soon as permission lands.
	private func requestMicrophone(then retry: @escaping @MainActor () -> Void) {
		if MicrophoneAccess.denied {
			error = VoiceError.microphoneDenied.localizedDescription
			return
		}
		awaitingPermission = true
		Task {
			let granted = await MicrophoneAccess.request()
			awaitingPermission = false
			if granted { retry() } else { error = VoiceError.microphoneDenied.localizedDescription }
		}
	}

	public var canListen: Bool { capabilities?.stt == true }
	public var canRead: Bool { capabilities?.tts == true }
	public var supportsHandsFree: Bool { capture.supportsMonitoring }

	public init(client: DeckClient, sessionId: String, handlers: VoiceHandlers) {
		self.client = client
		self.sessionId = sessionId
		self.handlers = handlers
		self.settings = VoiceSettings.load()
		#if os(iOS) || os(macOS)
		self.capture = EngineCapture()
		#else
		self.capture = RecorderCapture()
		#endif
		detector.threshold = settings.sensitivity.threshold
		detector.closeSeconds = settings.endOfSpeech.closeSeconds
	}

	/// Asks deck what the speech server offers; a request lost to a cold
	/// connection right after launch is retried rather than leaving voice mode
	/// hidden until the screen is opened again.
	public func loadCapabilities() async {
		for attempt in 0..<3 {
			if let found = try? await client.speechCapabilities() {
				capabilities = found
				return
			}
			try? await Task.sleep(for: .seconds(1 << attempt))
		}
	}

	// MARK: - On / off

	public func enable() {
		guard !enabled else { return }
		error = nil
		do {
			try configureSession()
		} catch {
			self.error = error.localizedDescription
			return
		}
		enabled = true
		#if os(macOS)
		// App Nap would throttle capture and requests while the window is hidden.
		activity = ProcessInfo.processInfo.beginActivity(options: .userInitiated, reason: "Voice mode")
		#endif
		watchRoute()
		startKeepAlive()
		startWorkingCue()
		warmAcknowledgements()
		if settings.handsFree { startHandsFree() }
	}

	public func disable() {
		enabled = false
		cueLoop?.cancel()
		cueLoop = nil
		keepAlive?.stop()
		keepAlive = nil
		stopPlayback()
		cancelRecording()
		stopHandsFree()
		ask = nil
		caption = ""
		status = .idle
		routeObserver.map(NotificationCenter.default.removeObserver)
		routeObserver = nil
		#if os(macOS)
		activity.map(ProcessInfo.processInfo.endActivity)
		activity = nil
		#else
		try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
		#endif
	}

	private func applySettings() {
		if persistsSettings { settings.save() }
		detector.threshold = settings.sensitivity.threshold
		detector.closeSeconds = settings.endOfSpeech.closeSeconds
		guard enabled else { return }
		// Hands-free is the one mode that needs echo cancellation; switching it
		// changes the session mode, which must happen with the mic closed.
		if settings.handsFree {
			try? configureSession()
			startHandsFree()
		} else {
			stopHandsFree()
			try? configureSession()
		}
	}

	// Play and record through one session that survives the screen locking. A
	// record-capable session reaches AirPods only over the hands-free profile,
	// so that option keeps them the route when worn; with nothing connected the
	// speaker is the fallback, not the earpiece. Voice-chat mode (echo
	// cancellation, so an open mic doesn't hear the speaker) is used only for
	// hands-free: it also runs playback through voice processing, which makes
	// the built-in speaker much quieter.
	private func configureSession() throws {
		#if !os(macOS)
		let session = AVAudioSession.sharedInstance()
		#if os(iOS)
		try session.setCategory(
			.playAndRecord, mode: settings.handsFree ? .voiceChat : .default,
			options: [.allowBluetoothHFP, .allowBluetoothA2DP, .defaultToSpeaker])
		#else
		try session.setCategory(.playAndRecord, mode: .default, options: [.allowBluetoothA2DP])
		#endif
		try session.setActive(true)
		updateRoute()
		#endif
	}

	private var routeObserver: NSObjectProtocol?

	private func watchRoute() {
		#if !os(macOS)
		updateRoute()
		guard routeObserver == nil else { return }
		routeObserver = NotificationCenter.default.addObserver(
			forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
		) { [weak self] _ in
			Task { @MainActor in self?.updateRoute() }
		}
		#endif
	}

	#if !os(macOS)
	private func updateRoute() {
		outputRoute = AVAudioSession.sharedInstance().currentRoute.outputs.map(\.portName).joined(separator: ", ")
	}
	#endif

	private func startKeepAlive() {
		#if os(iOS)
		let silence = VoiceAudio.wav(pcm16: Data(count: 16_000 * 2), sampleRate: 16_000)
		guard let player = try? AVAudioPlayer(data: silence) else { return }
		player.numberOfLoops = -1
		player.volume = 0
		player.play()
		keepAlive = player
		#endif
	}

	// MARK: - Reading

	/// A live transcript event. Assistant text is read (or held for the turn's
	/// end), an ask is read and routed, and an answer marker closes it.
	public func hear(_ event: JSONValue) {
		// A subagent's replies are its own work, not the session talking.
		guard enabled, (event["parent_tool_use_id"].string ?? "").isEmpty else { return }
		switch event["type"].string {
		case "assistant":
			for block in event["message"]["content"].array ?? [] { hearBlock(block) }
		case "result":
			turnFinished()
		default:
			if let answered = event["answersFor"].string, ask?.ask.askId == answered { ask = nil }
		}
	}

	private func hearBlock(_ block: JSONValue) {
		if block["type"].string == "text", let text = block["text"].string,
			!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
			assistantText(text)
		} else if block["type"].string == "tool_use", let id = block["id"].string,
			ToolCall.askTools.contains(block["name"].string ?? "") {
			let call = ToolCall(id: id, name: block["name"].string ?? "", input: block["input"])
			startAsk(DeckAsk(sessionId: sessionId, source: "mcp", askId: id, questions: call.questions))
		}
	}

	private func assistantText(_ markdown: String) {
		guard canRead else { return }
		if settings.chattiness == .finalOnly {
			lastText = markdown
		} else {
			replied = true
			speak(markdown, brief: true)
		}
	}

	private func turnFinished() {
		let text = lastText
		lastText = ""
		let willRead = settings.chattiness == .finalOnly && !text.isEmpty
		let done = VoiceCue.donePlays(willRead: willRead, replied: replied)
		replied = false
		// Queued behind what is being read (an acknowledgement) so it waits for
		// it; Skip, Stop and a new take drop it with the queue.
		if done { enqueue(Utterance(cue: .done)) }
		if willRead { speak(text, brief: true) }
	}

	private func startAsk(_ ask: DeckAsk) {
		guard !ask.questions.isEmpty else { return }
		let flow = VoiceAskFlow(ask: ask)
		self.ask = flow
		speak(flow.prompt, cue: .done)
	}

	/// `cue` plays just before the first segment, once whatever is ahead of
	/// it has been read. The utterance takes its place in the queue now; its
	/// segments arrive while earlier ones play. `brief` reads only the opening
	/// of a long reply.
	public func speak(_ text: String, cue: VoiceCue? = nil, brief: Bool = false) {
		guard enabled else { return }
		enqueue(Utterance(cue: cue, pending: fetchSegments(text, brief: brief)))
	}

	/// Read one message on request, with voice mode on or off. Off, only this
	/// message plays (through a playback-only session) and nothing else changes.
	public func readAloud(_ text: String) {
		if !enabled {
			#if !os(macOS)
			try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
			try? AVAudioSession.sharedInstance().setActive(true)
			#endif
			stopPlayback()
		}
		enqueue(Utterance(pending: fetchSegments(text)), standalone: true)
	}

	private func fetchSegments(_ text: String, brief: Bool = false) -> Task<[SpeechSegment], Never> {
		let client = self.client
		return Task {
			do { return try await client.speechSegments(text: text, brief: brief) } catch {
				self.error = error.localizedDescription
				return []
			}
		}
	}

	private func enqueue(_ utterance: Utterance, standalone: Bool = false) {
		queue.append(utterance)
		guard !playing else { return }
		// Set before the Task runs, so a second enqueue in this turn joins this drain.
		playing = true
		Task { await drain(standalone: standalone) }
	}

	/// Drop the rest of what is being read; the next utterance starts.
	public func skip() {
		guard !queue.isEmpty else { return }
		Utterance.skip(&queue)
		playToken += 1
		player.stop()
	}

	/// Stop reading and interrupt the turn.
	public func stop() {
		stopPlayback()
		Task {
			do { try await handlers.interrupt() } catch { self.error = error.localizedDescription }
		}
	}

	/// Drop everything queued to be read, without touching the turn.
	public func stopSpeaking() {
		stopPlayback()
	}

	private func stopPlayback() {
		queue = []
		playToken += 1
		player.stop()
		caption = ""
		if status == .speaking { rest() }
	}

	// `standalone` keeps playing with voice mode off (a one-off read-aloud).
	private func drain(standalone: Bool = false) async {
		defer {
			playing = false
			caption = ""
			if status == .speaking { rest() }
			onPlaybackFinished?()
		}
		while enabled || standalone, let head = queue.first {
			if let pending = head.pending {
				let segments = await pending.value
				// Skip/Stop may have dropped it meanwhile.
				if queue.first?.pending == pending {
					queue[0].segments = segments
					queue[0].pending = nil
				}
				continue
			}
			guard let segment = head.segments.first else {
				// Nothing to read: a done cue on its own, or a fetch that came back empty.
				let token = playToken
				if let cue = head.cue { try? await Task.sleep(for: .seconds(playCue(cue))) }
				if token == playToken { queue.removeFirst() }
				continue
			}
			let token = playToken
			guard let data = await audio(for: segment.id), token == playToken else {
				finishHead(token)
				continue
			}
			if let next = queue.first?.segments.dropFirst().first ?? queue.dropFirst().first?.segments.first { prefetch(next.id) }
			status = .speaking
			if let cue = queue.first?.cue {
				queue[0].cue = nil
				try? await Task.sleep(for: .seconds(playCue(cue)))
				// Skip/Stop landed during the cue.
				guard token == playToken else { continue }
			}
			caption = segment.text
			await player.play(data)
			finishHead(token)
		}
	}

	private func finishHead(_ token: Int) {
		guard token == playToken, !queue.isEmpty else { return }
		queue[0].segments.removeFirst()
		// An unplayed cue stays for drain to play on its own.
		if queue[0].segments.isEmpty, queue[0].cue == nil { queue.removeFirst() }
	}

	private func prefetch(_ id: String) {
		guard prefetched[id] == nil else { return }
		let client = self.client
		prefetched[id] = Task { try await client.speechAudio(id: id) }
	}

	private func audio(for id: String) async -> Data? {
		prefetch(id)
		defer { prefetched[id] = nil }
		do {
			return try await prefetched[id]?.value
		} catch {
			self.error = error.localizedDescription
			return nil
		}
	}

	// MARK: - Cues

	private func startWorkingCue() {
		cueLoop = Task { [weak self] in
			while !Task.isCancelled {
				try? await Task.sleep(for: .seconds(VoiceCue.workingSeconds))
				guard let self, !Task.isCancelled else { return }
				let busy = recording || status == .transcribing || playing || !queue.isEmpty
				if VoiceCue.workingPlays(wanted: settings.workingCue, working: turnRunning || sending, asking: ask != nil, busy: busy) {
					playCue(.working)
				}
			}
		}
	}

	// Its own player on the voice session, so a cue follows the reply's route
	// and never stops a reply; hands-free's echo cancellation hears it as output.
	// Returns how long it plays.
	@discardableResult
	private func playCue(_ cue: VoiceCue) -> TimeInterval {
		guard let player = try? AVAudioPlayer(data: cue.wav) else { return 0 }
		player.play()
		cuePlayer = player
		return player.duration
	}

	// Say a take was heard, in the reply's voice.
	private func acknowledge() {
		guard acknowledges, canRead else { return }
		speak(VoiceCue.acknowledgements[acknowledged % VoiceCue.acknowledgements.count])
		acknowledged += 1
	}

	// Synthesise the acknowledgements up front so the first one plays at once.
	private func warmAcknowledgements() {
		guard acknowledges, canRead else { return }
		let client = self.client
		Task {
			for text in VoiceCue.acknowledgements {
				for segment in (try? await client.speechSegments(text: text)) ?? [] { _ = try? await client.speechAudio(id: segment.id) }
			}
		}
	}

	// MARK: - Talking

	/// Hold-to-talk began (or the detector opened). Reading stops: the reply
	/// supersedes it. The first take asks for microphone permission.
	public func startRecording() {
		guard enabled, !recording, !awaitingPermission else { return }
		error = nil
		startMissed = false
		stopPlayback()
		guard micPermitted else {
			requestMicrophone { [weak self] in self?.startRecording() }
			return
		}
		do {
			try capture.beginTake()
		} catch {
			self.error = error.localizedDescription
			return
		}
		cancelled = false
		recording = true
		status = .listening
		caption = "Listening…"
		capture.onLevel = { [weak self] level in self?.onLevel(level) }
		takeTimer = Task { [weak self] in
			try? await Task.sleep(for: .seconds(VoiceTiming.maxTakeSeconds))
			if !Task.isCancelled { self?.stopRecording() }
		}
		if capabilities?.stream == true, capture.supportsStreaming {
			streamLoop = Task { [weak self] in await self?.streamTake() }
		}
	}

	// Cancelled when the take ends, which is what ties a late open to its take.
	private func streamTake() async {
		guard let id = try? await client.openTranscriptStream(), !Task.isCancelled else { return }
		streamId = id
		while !Task.isCancelled {
			try? await Task.sleep(for: .milliseconds(250))
			guard !Task.isCancelled, streamId == id else { return }
			let cutAt = Date().timeIntervalSinceReferenceDate
			let pcm = capture.drainStream()
			guard !pcm.isEmpty else { continue }
			let send = Task { await sendChunk(id, pcm, heardUntil: cutAt) }
			streamSend = send
			_ = await send.value
		}
	}

	// Hands-free, a finished sentence the transcriber heard enough silence
	// after ends the take there, with its text, rather than waiting out the
	// end-of-speech pause.
	private func sendChunk(_ id: String, _ pcm: Data, heardUntil: TimeInterval) async -> Bool {
		do {
			let text = try await client.streamAudio(id: id, pcm: pcm)
			guard streamId == id else { return true }
			if !text.isEmpty { caption = text }
			if settings.handsFree, supportsHandsFree, let quiet = detector.silentSince,
				VoiceEndpoint.settled(transcript: text, heardSilence: heardUntil - quiet) {
				settledText = text
				stopRecording()
				// The detector is mid-close; reset it so the next words open a new take.
				detector.reset()
			}
			return true
		} catch {
			if streamId == id { streamId = nil }
			return false
		}
	}

	public func stopRecording() {
		takeTimer?.cancel()
		guard recording else { return }
		recording = false
		level = 0
		let stream = streamId.map { (id: $0, sending: streamSend) }
		let settled = settledText
		settledText = nil
		streamId = nil
		streamLoop?.cancel()
		streamLoop = nil
		streamSend = nil
		let take = capture.endTake()
		let tail = capture.drainStream()
		if !VoiceAudio.keepsMicOpen(handsFree: settings.handsFree, supportsMonitoring: supportsHandsFree) { capture.stopMonitoring() }
		guard let take, VoiceAudio.isUsableTake(cancelled: cancelled, seconds: take.seconds, bytes: take.data.count) else {
			rest()
			return
		}
		status = .transcribing
		caption = "Transcribing…"
		Task { await transcribe(take, stream: stream.map { ($0.id, $0.sending, tail) }, settled: settled) }
	}

	public func cancelRecording() {
		cancelled = true
		stopRecording()
	}

	// A settled take sends its live text; otherwise the stream's final
	// transcript, else the whole take uploaded.
	private func transcribe(_ take: Take, stream: (id: String, sending: Task<Bool, Never>?, tail: Data)?, settled: String?) async {
		if let stream, let settled {
			Task { [client] in _ = try? await client.endTranscriptStream(id: stream.id, pcm: stream.tail) }
			await deliver(settled.trimmingCharacters(in: .whitespacesAndNewlines))
			rest()
			return
		}
		do {
			var streamed: Transcription?
			if let stream, await stream.sending?.value ?? true {
				streamed = try? await client.endTranscriptStream(id: stream.id, pcm: stream.tail)
			}
			let result = if let streamed { streamed } else { try await client.transcribe(audio: take.data, mimeType: take.mimeType) }
			await deliver(result.text.trimmingCharacters(in: .whitespacesAndNewlines))
		} catch {
			self.error = error.localizedDescription
		}
		rest()
	}

	// A transcript answers the open question when there is one, else it is a
	// message to the session. Silence goes nowhere.
	private func deliver(_ text: String) async {
		caption = text
		guard !text.isEmpty else { return }
		sending = true
		defer { sending = false }
		acknowledge()
		do {
			if var flow = ask {
				flow.answer(text)
				if flow.isComplete {
					ask = nil
					try await handlers.answer(flow.ask, flow.draft)
				} else {
					ask = flow
					speak(flow.prompt)
				}
			} else {
				try await handlers.send(text)
			}
		} catch {
			self.error = error.localizedDescription
		}
	}

	private func rest() {
		status = settings.handsFree && enabled && supportsHandsFree ? .listening : .idle
		if caption == "Transcribing…" { caption = "" }
		if status == .listening, caption.isEmpty { caption = "Listening…" }
	}

	// MARK: - Hands-free

	private func startHandsFree() {
		guard enabled, canListen, supportsHandsFree, !awaitingPermission else { return }
		guard micPermitted else {
			requestMicrophone { [weak self] in self?.startHandsFree() }
			return
		}
		detector.reset()
		startMissed = false
		capture.onLevel = { [weak self] level in self?.onLevel(level) }
		do {
			try capture.startMonitoring()
			// Monitoring can find it has no echo cancellation; the mic then closes.
			if !supportsHandsFree { capture.stopMonitoring() }
			rest()
		} catch {
			self.error = error.localizedDescription
		}
	}

	private func stopHandsFree() {
		if !recording { capture.stopMonitoring() }
		detector.reset()
		startMissed = false
		if status == .listening, !recording {
			status = .idle
			caption = ""
		}
	}

	/// The recogniser's transcript so far.
	public func heard(_ transcript: String) {
		if BargeIn.addsWords(transcript, to: self.transcript) { wordsAt = Date().timeIntervalSinceReferenceDate }
		self.transcript = transcript
	}

	private func onLevel(_ level: Float) {
		self.level = min(1, level * 6)
		guard settings.handsFree, supportsHandsFree else { return }
		let now = Date().timeIntervalSinceReferenceDate
		let edge = detector.update(level: level, at: now)
		if edge == .stop { startMissed = false }
		if edge == .start, status == .speaking { startMissed = true }
		if edge == .stop, recording {
			stopRecording()
		} else if status == .speaking {
			// Talking over a reply takes the turn even with the gate shut.
			if !recording, BargeIn.interrupts(detector, now: now, wordsAt: wordsAt) { startRecording() }
		} else if edge == .start || startMissed, !recording, status != .transcribing, listenGate {
			startRecording()
		}
	}
}

// MARK: - Microphone permission

/// The microphone prompt. iOS and watchOS ask through AVAudioApplication; the
/// Mac asks through AVCaptureDevice, which is what its privacy settings and
/// the sandbox's audio-input entitlement answer to.
@MainActor
enum MicrophoneAccess {
	#if os(macOS)
	static var granted: Bool { AVCaptureDevice.authorizationStatus(for: .audio) == .authorized }
	static var denied: Bool {
		let status = AVCaptureDevice.authorizationStatus(for: .audio)
		return status == .denied || status == .restricted
	}
	static func request() async -> Bool { await AVCaptureDevice.requestAccess(for: .audio) }
	#else
	static var granted: Bool { AVAudioApplication.shared.recordPermission == .granted }
	static var denied: Bool { AVAudioApplication.shared.recordPermission == .denied }
	static func request() async -> Bool { await AVAudioApplication.requestRecordPermission() }
	#endif
}

// MARK: - Playback

/// One AVAudioPlayer at a time, awaited to completion; `stop` ends it early.
@MainActor
private final class SpeechPlayer: NSObject, AVAudioPlayerDelegate {
	private var player: AVAudioPlayer?
	private var continuation: CheckedContinuation<Void, Never>?

	func play(_ data: Data) async {
		stop()
		guard let player = try? AVAudioPlayer(data: data) else { return }
		player.delegate = self
		self.player = player
		await withCheckedContinuation { continuation in
			self.continuation = continuation
			if !player.play() { finish() }
		}
	}

	func stop() {
		player?.stop()
		player = nil
		finish()
	}

	private func finish() {
		continuation?.resume()
		continuation = nil
	}

	nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
		Task { @MainActor in self.finish() }
	}

	nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
		Task { @MainActor in self.finish() }
	}
}

// MARK: - Capture

struct Take {
	let data: Data
	let mimeType: String
	let seconds: TimeInterval
}

/// A microphone source that can report its level continuously (hands-free)
/// and capture a take on demand.
@MainActor
protocol TakeCapture: AnyObject {
	var onLevel: ((Float) -> Void)? { get set }
	var supportsMonitoring: Bool { get }
	/// Whether a take's PCM can be streamed while it is open.
	var supportsStreaming: Bool { get }
	func startMonitoring() throws
	func stopMonitoring()
	func beginTake() throws
	func endTake() -> Take?
	/// The take's 16 kHz 16-bit mono PCM captured since the last drain.
	func drainStream() -> Data
}

#if os(iOS) || os(macOS)
/// AVAudioEngine input tap: levels flow whenever the engine runs, and a take
/// is the 16 kHz 16-bit mono PCM captured between begin and end, led by the
/// pre-roll from just before begin, wrapped as WAV for upload. The tap runs on
/// the audio thread, so the take state sits behind a lock and only the level
/// callback hops to the main actor.
@MainActor
final class EngineCapture: TakeCapture {
	var onLevel: ((Float) -> Void)?
	/// A second reader of the tap (a wake-word recogniser), on the audio thread.
	nonisolated(unsafe) var onBuffer: ((AVAudioPCMBuffer) -> Void)?
	/// Whether the engine may stay running between takes for hands-free.
	private(set) var supportsMonitoring = true
	let supportsStreaming = true

	private let engine = AVAudioEngine()
	private let sink = TakeSink()
	private var takeStart: Date?
	private var monitoring = false

	func startMonitoring() throws {
		guard !monitoring else { return }
		let input = engine.inputNode
		#if os(macOS)
		// Echo cancellation, so an open mic doesn't hear the reply; it changes
		// the input format, so the format is read after it. An input that
		// refuses it keeps push-to-talk but not hands-free.
		if !input.isVoiceProcessingEnabled {
			do { try input.setVoiceProcessingEnabled(true) } catch { supportsMonitoring = false }
		}
		#endif
		let format = input.outputFormat(forBus: 0)
		// installTap raises an Objective-C exception (uncatchable here) on an
		// empty format, which is what a missing or denied microphone yields.
		guard format.sampleRate > 0, format.channelCount > 0 else { throw VoiceError.microphoneUnavailable }
		sink.prepare(from: format)
		let sink = self.sink
		input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
			let level = sink.consume(buffer)
			self?.onBuffer?(buffer)
			Task { @MainActor in self?.onLevel?(level) }
		}
		engine.prepare()
		try engine.start()
		monitoring = true
	}

	func stopMonitoring() {
		guard monitoring else { return }
		engine.inputNode.removeTap(onBus: 0)
		engine.stop()
		monitoring = false
	}

	func beginTake() throws {
		try startMonitoring()
		takeStart = Date()
		sink.begin()
	}

	func endTake() -> Take? {
		guard let pcm = sink.end() else { return nil }
		let seconds = takeStart.map { Date().timeIntervalSince($0) } ?? 0
		takeStart = nil
		return Take(data: VoiceAudio.wav(pcm16: pcm, sampleRate: 16_000), mimeType: "audio/wav", seconds: seconds)
	}

	func drainStream() -> Data { sink.drain() }
}

/// The audio-thread half of EngineCapture: measures every buffer, converts it
/// to 16 kHz Int16 mono, and keeps the last second of it as pre-roll; a take
/// starts from that pre-roll and appends from there.
private final class TakeSink: @unchecked Sendable {
	private let lock = NSLock()
	private var converter: AVAudioConverter?
	private var taking = false
	private var pcm = Data()
	// The take's PCM not yet streamed; left after end so the last of it can be.
	private var pending = Data()
	private var ring = PcmRing(capacity: Int(VoiceTiming.preRollSeconds * 16_000) * 2)
	private let targetFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!

	func prepare(from format: AVAudioFormat) {
		lock.withLock {
			converter = AVAudioConverter(from: format, to: targetFormat)
			ring.removeAll()
		}
	}

	func begin() {
		lock.withLock {
			pcm = ring.data
			pending = pcm
			taking = true
		}
	}

	func end() -> Data? {
		lock.withLock {
			guard taking else { return nil }
			taking = false
			defer { pcm = Data() }
			return pcm
		}
	}

	func drain() -> Data {
		lock.withLock {
			defer { pending = Data() }
			return pending
		}
	}

	/// Returns the buffer's level; keeps its samples as pre-roll, and in the
	/// take when one is open.
	func consume(_ buffer: AVAudioPCMBuffer) -> Float {
		let level = buffer.floatChannelData.map { channels in
			VoiceAudio.rms(UnsafeBufferPointer(start: channels[0], count: Int(buffer.frameLength)))
		} ?? 0
		lock.withLock {
			guard let converter, let converted = convert(buffer, with: converter) else { return }
			if taking {
				pcm.append(converted)
				pending.append(converted)
			}
			ring.append(converted)
		}
		return level
	}

	private func convert(_ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter) -> Data? {
		let ratio = targetFormat.sampleRate / buffer.format.sampleRate
		let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 16
		guard let out = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return nil }
		var consumed = false
		var conversionError: NSError?
		converter.convert(to: out, error: &conversionError) { _, status in
			if consumed {
				status.pointee = .noDataNow
				return nil
			}
			consumed = true
			status.pointee = .haveData
			return buffer
		}
		guard conversionError == nil, let bytes = out.int16ChannelData else { return nil }
		return Data(bytes: bytes[0], count: Int(out.frameLength) * 2)
	}
}
#else
/// AVAudioRecorder to an AAC file: what the watch supports well. No level
/// stream before a take, so no hands-free.
@MainActor
final class RecorderCapture: TakeCapture {
	var onLevel: ((Float) -> Void)?
	let supportsMonitoring = false
	let supportsStreaming = false

	private var recorder: AVAudioRecorder?
	private var meter: Task<Void, Never>?
	private var url: URL?

	func startMonitoring() throws {}
	func stopMonitoring() {}

	func beginTake() throws {
		let url = FileManager.default.temporaryDirectory.appendingPathComponent("deck-take-\(UUID().uuidString).m4a")
		let recorder = try AVAudioRecorder(url: url, settings: [
			AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
			AVSampleRateKey: 16_000,
			AVNumberOfChannelsKey: 1,
			AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue
		])
		recorder.isMeteringEnabled = true
		guard recorder.record() else { throw VoiceError.microphoneUnavailable }
		self.recorder = recorder
		self.url = url
		meter = Task { [weak self] in
			while !Task.isCancelled {
				try? await Task.sleep(for: .milliseconds(80))
				guard let self, let recorder = self.recorder else { return }
				recorder.updateMeters()
				let db = recorder.averagePower(forChannel: 0)
				self.onLevel?(pow(10, db / 20))
			}
		}
	}

	func endTake() -> Take? {
		meter?.cancel()
		guard let recorder, let url else { return nil }
		let seconds = recorder.currentTime
		recorder.stop()
		self.recorder = nil
		self.url = nil
		defer { try? FileManager.default.removeItem(at: url) }
		guard let data = try? Data(contentsOf: url) else { return nil }
		return Take(data: data, mimeType: "audio/mp4", seconds: seconds)
	}

	func drainStream() -> Data { Data() }
}
#endif

#endif
