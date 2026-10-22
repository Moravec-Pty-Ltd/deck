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
	private var queue: [[SpeechSegment]] = []
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
	private var awaitingPermission = false

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
		watchRoute()
		startKeepAlive()
		if settings.handsFree { startHandsFree() }
	}

	public func disable() {
		enabled = false
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
		#if !os(macOS)
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
		if settings.chattiness == .finalOnly { lastText = markdown } else { speak(markdown) }
	}

	private func turnFinished() {
		let text = lastText
		lastText = ""
		if settings.chattiness == .finalOnly, !text.isEmpty { speak(text) }
	}

	private func startAsk(_ ask: DeckAsk) {
		guard !ask.questions.isEmpty else { return }
		let flow = VoiceAskFlow(ask: ask)
		self.ask = flow
		speak(flow.prompt)
	}

	public func speak(_ text: String) {
		Task { await enqueue(text) }
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
		Task { await enqueue(text, standalone: true) }
	}

	private func enqueue(_ text: String, standalone: Bool = false) async {
		do {
			let segments = try await client.speechSegments(text: text)
			guard enabled || standalone, !segments.isEmpty else { return }
			queue.append(segments)
			if !playing { await drain(standalone: standalone) }
		} catch {
			self.error = error.localizedDescription
		}
	}

	/// Drop the rest of what is being read; the next utterance starts.
	public func skip() {
		guard !queue.isEmpty else { return }
		queue.removeFirst()
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
		playing = true
		defer {
			playing = false
			caption = ""
			if status == .speaking { rest() }
			onPlaybackFinished?()
		}
		while enabled || standalone, let segment = queue.first?.first {
			let token = playToken
			guard let data = await audio(for: segment.id), token == playToken else {
				finishHead(token)
				continue
			}
			if let next = queue.first?.dropFirst().first ?? queue.dropFirst().first?.first { prefetch(next.id) }
			status = .speaking
			caption = segment.text
			await player.play(data)
			finishHead(token)
		}
	}

	private func finishHead(_ token: Int) {
		guard token == playToken, !queue.isEmpty else { return }
		queue[0].removeFirst()
		if queue[0].isEmpty { queue.removeFirst() }
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
	}

	public func stopRecording() {
		takeTimer?.cancel()
		guard recording else { return }
		recording = false
		level = 0
		let take = capture.endTake()
		if !VoiceAudio.keepsMicOpen(handsFree: settings.handsFree, supportsMonitoring: supportsHandsFree) { capture.stopMonitoring() }
		guard let take, VoiceAudio.isUsableTake(cancelled: cancelled, seconds: take.seconds, bytes: take.data.count) else {
			rest()
			return
		}
		status = .transcribing
		caption = "Transcribing…"
		Task { await transcribe(take) }
	}

	public func cancelRecording() {
		cancelled = true
		stopRecording()
	}

	private func transcribe(_ take: Take) async {
		do {
			let result = try await client.transcribe(audio: take.data, mimeType: take.mimeType)
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
	func startMonitoring() throws
	func stopMonitoring()
	func beginTake() throws
	func endTake() -> Take?
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
}

/// The audio-thread half of EngineCapture: measures every buffer, converts it
/// to 16 kHz Int16 mono, and keeps the last second of it as pre-roll; a take
/// starts from that pre-roll and appends from there.
private final class TakeSink: @unchecked Sendable {
	private let lock = NSLock()
	private var converter: AVAudioConverter?
	private var taking = false
	private var pcm = Data()
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

	/// Returns the buffer's level; keeps its samples as pre-roll, and in the
	/// take when one is open.
	func consume(_ buffer: AVAudioPCMBuffer) -> Float {
		let level = buffer.floatChannelData.map { channels in
			VoiceAudio.rms(UnsafeBufferPointer(start: channels[0], count: Int(buffer.frameLength)))
		} ?? 0
		lock.withLock {
			guard let converter, let converted = convert(buffer, with: converter) else { return }
			if taking { pcm.append(converted) }
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
}
#endif

#endif
