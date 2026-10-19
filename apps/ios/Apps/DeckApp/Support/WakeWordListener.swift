import AVFoundation
import Speech

/// Hears "hey deck" in the microphone using Apple's speech recognition, fed
/// from the same audio tap the voice controller records with. Recognition
/// requests are capped at about a minute, so the task is restarted on a
/// timer, after each wake, and (with a pause) after an error. On-device
/// recognition is preferred but not required: requiring it fails outright
/// on a locale whose model is not installed.
@MainActor
final class WakeWordListener {
	var onWake: (() -> Void)?
	/// What the recogniser last heard and the last error, for the screen, so
	/// a wake word that does not land can be seen rather than guessed at.
	var onHeard: ((String) -> Void)?
	var onError: ((String) -> Void)?
	private(set) var running = false
	private(set) var available = false

	private let recognizer: SFSpeechRecognizer?
	private let feeder = BufferFeeder()
	private var task: SFSpeechRecognitionTask?
	private var restartTimer: Task<Void, Never>?
	private var consecutiveErrors = 0

	init() {
		// The first English recogniser that can work on the device wins; a
		// server-backed one still works, just not offline.
		let candidates = [Locale.current, Locale(identifier: "en-AU"), Locale(identifier: "en-US")].compactMap(SFSpeechRecognizer.init(locale:))
		recognizer = candidates.first(where: { $0.supportsOnDeviceRecognition }) ?? candidates.first
	}

	static func authorize() async -> Bool {
		await withCheckedContinuation { continuation in
			SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0 == .authorized) }
		}
	}

	/// Append a captured buffer; safe from the audio thread.
	nonisolated func append(_ buffer: AVAudioPCMBuffer) {
		feeder.append(buffer)
	}

	func start() {
		guard !running else { return }
		guard let recognizer, recognizer.isAvailable else {
			available = false
			onError?("Speech recognition is not available on this device.")
			return
		}
		available = true
		running = true
		consecutiveErrors = 0
		beginTask()
	}

	func stop() {
		running = false
		restartTimer?.cancel()
		endTask()
	}

	private func beginTask() {
		guard running, let recognizer else { return }
		let request = SFSpeechAudioBufferRecognitionRequest()
		request.shouldReportPartialResults = true
		request.requiresOnDeviceRecognition = false
		request.contextualStrings = ["deck", "hey deck"]
		feeder.set(request)
		task = recognizer.recognitionTask(with: request) { [weak self] result, error in
			Task { @MainActor in self?.handle(result, error) }
		}
		restartTimer?.cancel()
		restartTimer = Task { [weak self] in
			try? await Task.sleep(for: .seconds(50))
			guard !Task.isCancelled else { return }
			self?.restart()
		}
	}

	private func endTask() {
		feeder.set(nil)
		task?.cancel()
		task = nil
	}

	private func restart(after seconds: Double = 0) {
		endTask()
		guard seconds > 0 else {
			beginTask()
			return
		}
		restartTimer?.cancel()
		restartTimer = Task { [weak self] in
			try? await Task.sleep(for: .seconds(seconds))
			guard !Task.isCancelled else { return }
			self?.beginTask()
		}
	}

	private func handle(_ result: SFSpeechRecognitionResult?, _ error: Error?) {
		guard running else { return }
		if let result {
			consecutiveErrors = 0
			let transcript = result.bestTranscription.formattedString
			onHeard?(transcript)
			if Self.heard(transcript) {
				restart()
				onWake?()
				return
			}
			if result.isFinal { restart() }
			return
		}
		guard let error else { return }
		// A task that ends because the audio went quiet is normal; a task that
		// keeps failing at once is not, and would otherwise spin.
		consecutiveErrors += 1
		if consecutiveErrors >= 5 {
			onError?("Speech recognition keeps failing: \(error.localizedDescription)")
			restart(after: 10)
		} else {
			restart(after: 1)
		}
	}

	/// What the recogniser tends to make of "hey deck": the trigger word, a
	/// short pause, then any of the ways "deck" comes out.
	static func heard(_ transcript: String) -> Bool {
		let said = transcript.lowercased()
		return said.range(of: #"\b(hey|hay|hi|a|hey there)[,.]?\s*(deck|dec|dex|deak|tech|tek|jack|dick)\b"#, options: .regularExpression) != nil
	}
}

/// The audio-thread side: the request buffers go to, swapped under a lock as
/// tasks restart.
private final class BufferFeeder: @unchecked Sendable {
	private let lock = NSLock()
	private var request: SFSpeechAudioBufferRecognitionRequest?

	func set(_ request: SFSpeechAudioBufferRecognitionRequest?) {
		lock.withLock {
			self.request?.endAudio()
			self.request = request
		}
	}

	func append(_ buffer: AVAudioPCMBuffer) {
		lock.withLock { request?.append(buffer) }
	}
}
