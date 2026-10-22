import Foundation

// Pure logic for voice mode, the same rules the web bar follows: per-device
// settings, how a question is read, which option a spoken reply picks, the
// one-question-at-a-time answer flow, the energy-gated voice detector, and a
// WAV encoder for uploads. No AVFoundation here; VoiceController owns that.

public enum Chattiness: String, CaseIterable, Codable, Sendable {
	case everyUpdate = "every-update"
	case finalOnly = "final-only"

	public var label: String {
		switch self {
		case .everyUpdate: return "Every update"
		case .finalOnly: return "Final reply only"
		}
	}
}

public enum VadSensitivity: String, CaseIterable, Codable, Sendable {
	case low, medium, high

	/// RMS threshold (0..1) speech must reach to open the mic. High opens on
	/// quieter speech and so on more room noise.
	public var threshold: Float {
		switch self {
		case .low: return 0.06
		case .medium: return 0.035
		case .high: return 0.02
		}
	}
}

/// How long a pause ends a hands-free take.
public enum EndOfSpeech: String, CaseIterable, Codable, Sendable {
	case short, normal, long

	public var closeSeconds: TimeInterval {
		switch self {
		case .short: return 1.2
		case .normal: return 2
		case .long: return 3
		}
	}
}

public struct VoiceSettings: Codable, Equatable, Sendable {
	public var chattiness: Chattiness = .everyUpdate
	public var handsFree = true
	public var sensitivity: VadSensitivity = .medium
	public var endOfSpeech: EndOfSpeech = .normal
	/// Bumped when a default changes for everyone. Both clients save the whole
	/// object, so a stored false is not a choice until it carries this version.
	public private(set) var version = VoiceSettings.currentVersion
	static let currentVersion = 2

	public init(chattiness: Chattiness = .everyUpdate, handsFree: Bool = true, sensitivity: VadSensitivity = .medium, endOfSpeech: EndOfSpeech = .normal) {
		self.chattiness = chattiness
		self.handsFree = handsFree
		self.sensitivity = sensitivity
		self.endOfSpeech = endOfSpeech
	}

	// Each key is optional so settings saved before a key existed keep the rest
	// and take the default for what is missing.
	public init(from decoder: Decoder) throws {
		let container = try decoder.container(keyedBy: CodingKeys.self)
		chattiness = try container.decodeIfPresent(Chattiness.self, forKey: .chattiness) ?? .everyUpdate
		let stored = try container.decodeIfPresent(Int.self, forKey: .version) ?? 0
		handsFree = stored < Self.currentVersion ? true : try container.decodeIfPresent(Bool.self, forKey: .handsFree) ?? true
		sensitivity = try container.decodeIfPresent(VadSensitivity.self, forKey: .sensitivity) ?? .medium
		endOfSpeech = (try? container.decodeIfPresent(EndOfSpeech.self, forKey: .endOfSpeech)) ?? .normal
	}

	static let defaultsKey = "deck.voice.settings"

	public static func load(from defaults: UserDefaults = .standard) -> VoiceSettings {
		guard let data = defaults.data(forKey: defaultsKey),
			let settings = try? JSONDecoder().decode(VoiceSettings.self, from: data)
		else { return VoiceSettings() }
		return settings
	}

	public func save(to defaults: UserDefaults = .standard) {
		if let data = try? JSONEncoder().encode(self) { defaults.set(data, forKey: Self.defaultsKey) }
	}
}

/// Speech must hold above the threshold this long to open the mic, and drop
/// below it this long (the end-of-speech setting) to close it.
public enum VoiceTiming {
	public static let openSeconds: TimeInterval = 0.2
	public static let closeSeconds = EndOfSpeech.normal.closeSeconds
	/// How much audio from before the detector opened a take starts with.
	public static let preRollSeconds: TimeInterval = 1
	public static let maxTakeSeconds: TimeInterval = 120
	public static let minTakeSeconds: TimeInterval = 0.5
}

// MARK: - Questions

private let numberWords = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]
private let ordinalWords = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"]

public enum VoiceQuestions {
	/// How a blocking question is read: the question, then numbered options so a
	/// spoken "two" is enough to pick one. A set of questions counts them off.
	public static func speech(for question: AskQuestion, index: Int = 0, total: Int = 1) -> String {
		var parts: [String] = []
		parts.append(total > 1 ? "Question \(index + 1) of \(total). \(question.question)" : question.question)
		let options = question.options ?? []
		if !options.isEmpty {
			let listed = options.enumerated().map { i, option in
				"\(i < numberWords.count ? numberWords[i] : String(i + 1)), \(option.label)"
			}.joined(separator: ". ")
			parts.append("Options: \(listed).")
		}
		return parts.joined(separator: " ")
	}

	private static func normalise(_ s: String) -> String {
		let lowered = s.lowercased()
		let cleaned = lowered.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) ? Character($0) : " " }
		return String(cleaned).split(separator: " ").joined(separator: " ")
	}

	/// The option a spoken reply picks: its label, a number ("two", "2",
	/// "option two"), or an ordinal ("the second one"). Nil means send the reply
	/// as free text. Naming two options is a sentence for the agent, not a pick.
	public static func match(_ transcript: String, options: [AskOption]) -> String? {
		let said = normalise(transcript)
		guard !said.isEmpty, !options.isEmpty else { return nil }
		let labels = options.map { normalise($0.label) }
		let padded = " \(said) "
		let contained = labels.indices.filter { !labels[$0].isEmpty && padded.contains(" \(labels[$0]) ") }
		if contained.count > 1 { return nil }
		if let exact = labels.firstIndex(of: said) { return options[exact].label }
		var stripped = said
		for prefix in ["option ", "number ", "the ", "choose ", "pick ", "select ", "go with "] where stripped.hasPrefix(prefix) {
			stripped = String(stripped.dropFirst(prefix.count))
		}
		for suffix in [" one", " option", " please"] where stripped.hasSuffix(suffix) {
			stripped = String(stripped.dropLast(suffix.count))
		}
		for i in options.indices {
			var tokens = [String(i + 1)]
			if i < numberWords.count { tokens += [numberWords[i], ordinalWords[i]] }
			if tokens.contains(stripped) { return options[i].label }
		}
		return contained.first.map { options[$0].label }
	}
}

/// A blocking question being answered by voice, one question at a time. Picks
/// and free text land in the same draft the tapped card submits, so the
/// answer posts identically.
public struct VoiceAskFlow: Equatable, Sendable {
	public let ask: DeckAsk
	public private(set) var draft: AskAnswerDraft
	public private(set) var index = 0

	public init(ask: DeckAsk) {
		self.ask = ask
		self.draft = AskAnswerDraft(questions: ask.questions)
	}

	public var question: AskQuestion? {
		ask.questions.indices.contains(index) ? ask.questions[index] : nil
	}

	/// What to read for the current question.
	public var prompt: String {
		guard let question else { return "" }
		return VoiceQuestions.speech(for: question, index: index, total: ask.questions.count)
	}

	public var isComplete: Bool { index >= ask.questions.count && draft.isComplete }

	/// Fold a spoken reply into the current question and move on.
	public mutating func answer(_ transcript: String) {
		guard let question else { return }
		if let label = VoiceQuestions.match(transcript, options: question.options ?? []) {
			draft.toggle(label, question: index)
		} else {
			draft.setReply(transcript.trimmingCharacters(in: .whitespacesAndNewlines), question: index)
		}
		index += 1
	}
}

// MARK: - Detector

/// Energy-gated voice activity: speech must hold above the threshold for
/// `openSeconds` to open, and stay below it for `closeSeconds` to close. Time
/// is passed in so it unit-tests without a clock.
public struct VoiceDetector: Sendable {
	public enum Edge: Sendable { case start, stop }
	public enum State: Sendable { case silent, opening, open, closing }

	public private(set) var state: State = .silent
	/// While loud, when this run of speech began, bridging dips shorter than
	/// `BargeIn.gapSeconds` between words; nil while quiet.
	public var loudSince: TimeInterval? { quietSince == nil ? runStart : nil }
	/// While quiet, when the quiet began; nil while loud.
	public var silentSince: TimeInterval? { quietSince }
	private var runStart: TimeInterval?
	private var quietSince: TimeInterval?
	public var threshold: Float
	public var closeSeconds: TimeInterval
	private let openSeconds: TimeInterval
	private var since: TimeInterval = 0

	public init(threshold: Float, openSeconds: TimeInterval = VoiceTiming.openSeconds, closeSeconds: TimeInterval = VoiceTiming.closeSeconds) {
		self.threshold = threshold
		self.openSeconds = openSeconds
		self.closeSeconds = closeSeconds
	}

	public mutating func reset() {
		state = .silent
		runStart = nil
		quietSince = nil
	}

	/// Feed one level reading; returns the edge the recorder should act on.
	public mutating func update(level: Float, at now: TimeInterval) -> Edge? {
		let loud = level >= threshold
		if loud {
			let gapEnded = quietSince.map { now - $0 >= BargeIn.gapSeconds } ?? false
			runStart = gapEnded ? now : runStart ?? now
			quietSince = nil
		} else {
			quietSince = quietSince ?? now
			if let quietSince, now - quietSince >= BargeIn.gapSeconds { runStart = nil }
		}
		switch state {
		case .silent:
			if loud { state = .opening; since = now }
		case .open:
			if !loud { state = .closing; since = now }
		case .opening:
			if !loud { state = .silent } else if now - since >= openSeconds { state = .open; return .start }
		case .closing:
			if loud { state = .open } else if now - since >= closeSeconds { state = .silent; return .stop }
		}
		return nil
	}
}

/// When speech over a reply cuts it off.
public enum BargeIn {
	/// Unbroken loudness must hold this long, longer than a take needs to open,
	/// so the reply's own echo or a cough doesn't.
	public static let holdSeconds: TimeInterval = 0.45
	/// A dip this short is the gap between words, not the end of speech.
	public static let gapSeconds: TimeInterval = 0.12
	/// How recent new words must be; a recogniser reports them up to a second
	/// after they are said.
	public static let wordsSeconds: TimeInterval = 1

	/// New words from a recogniser while the detector is open on speech, so a
	/// short "stop" counts; else unbroken loudness held for `holdSeconds`, which
	/// also covers a recogniser that is down or has stalled.
	public static func interrupts(_ vad: VoiceDetector, now: TimeInterval, wordsAt: TimeInterval?) -> Bool {
		if vad.state == .open || vad.state == .closing, let wordsAt, now - wordsAt <= wordsSeconds { return true }
		return vad.loudSince.map { now - $0 >= holdSeconds } ?? false
	}

	/// Whether a recogniser's latest transcript adds words to the last one; it
	/// resends the whole transcript on every revision.
	public static func addsWords(_ transcript: String, to previous: String) -> Bool {
		transcript.split(separator: " ").count > previous.split(separator: " ").count
	}
}

/// When a live transcript lets a take close early: a finished sentence ends
/// after a short pause instead of the end-of-speech setting.
public enum VoiceEndpoint {
	/// Silence the transcriber must have heard before a finished sentence ends
	/// a take. A streaming model emits a word up to about 0.9 s after it is
	/// said (Voxtral Realtime at a 480 ms delay; 0.65 s at 240 ms), so by then
	/// the live text holds everything said before the pause.
	public static let settledSeconds: TimeInterval = 1
	// Words a sentence doesn't end on: a trailing one means more is coming.
	private static let trailingWords: Set = ["and", "but", "or", "so", "because", "then", "um", "uh", "er", "like", "the", "a", "an", "to", "of", "with", "if", "that"]

	public static func looksFinished(_ transcript: String) -> Bool {
		let t = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
		guard t.range(of: #"[.!?]["')\]]*$"#, options: .regularExpression) != nil,
			t.range(of: #"(\.\.\.|…)["')\]]*$"#, options: .regularExpression) == nil else { return false }
		let lower = t.lowercased()
		guard let last = lower.range(of: #"[a-z']+(?=[^a-z']*$)"#, options: .regularExpression) else { return true }
		return !trailingWords.contains(String(lower[last]))
	}

	/// Whether the live text can end the take now and be sent as is.
	public static func settled(transcript: String, heardSilence: TimeInterval) -> Bool {
		heardSilence >= settledSeconds && looksFinished(transcript)
	}
}

// MARK: - Pre-roll

/// The newest `capacity` bytes: the lead-in a take starts with, since the
/// detector only opens once speech is already under way.
public struct PcmRing: Sendable {
	public private(set) var data = Data()
	private let capacity: Int

	public init(capacity: Int) {
		self.capacity = capacity
	}

	public mutating func append(_ bytes: Data) {
		data.append(bytes)
		// A fresh copy, so the dropped bytes are freed and indices start at 0.
		if data.count > capacity { data = Data(data.suffix(capacity)) }
	}

	public mutating func removeAll() { data = Data() }
}

// MARK: - Audio helpers

public enum VoiceAudio {
	/// RMS of a PCM frame in [-1, 1].
	public static func rms(_ samples: UnsafeBufferPointer<Float>) -> Float {
		guard !samples.isEmpty else { return 0 }
		var sum: Float = 0
		for v in samples { sum += v * v }
		return (sum / Float(samples.count)).squareRoot()
	}

	/// A 16-bit mono PCM WAV file around raw little-endian samples.
	public static func wav(pcm16: Data, sampleRate: Int) -> Data {
		var data = Data()
		func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
		func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
		data.append(contentsOf: Array("RIFF".utf8))
		u32(UInt32(36 + pcm16.count))
		data.append(contentsOf: Array("WAVE".utf8))
		data.append(contentsOf: Array("fmt ".utf8))
		u32(16)
		u16(1)
		u16(1)
		u32(UInt32(sampleRate))
		u32(UInt32(sampleRate * 2))
		u16(2)
		u16(16)
		data.append(contentsOf: Array("data".utf8))
		u32(UInt32(pcm16.count))
		data.append(pcm16)
		return data
	}

	/// Whether the mic stays open once a take ends: only for hands-free, and
	/// only where the capture can monitor (the watch cannot, so a
	/// hands-free setting carried over from elsewhere must not leave the mic on).
	public static func keepsMicOpen(handsFree: Bool, supportsMonitoring: Bool) -> Bool {
		handsFree && supportsMonitoring
	}

	/// Whether a finished take is worth transcribing. `seconds` runs from when
	/// the take began, so the pre-roll before it is not counted.
	public static func isUsableTake(cancelled: Bool, seconds: TimeInterval, bytes: Int) -> Bool {
		!cancelled && seconds >= VoiceTiming.minTakeSeconds && bytes > 0
	}
}
