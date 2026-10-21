import Foundation

/// Whether an operator can run here, and what to say when it cannot.
public enum OperatorAvailability: Equatable, Sendable {
	case available
	/// The OS is older than the on-device model (iOS or macOS 26).
	case systemTooOld
	/// This platform has no on-device model at all. watchOS ships the
	/// framework but marks SystemLanguageModel unavailable, so a watch cannot
	/// think for itself however new it is.
	case platformUnsupported
	/// This device cannot run Apple Intelligence.
	case deviceNotEligible
	/// Apple Intelligence is off, or the model is still downloading.
	case notReady

	public var reason: String? { reason(on: .current) }

	public func reason(on platform: AppPlatform) -> String? {
		switch self {
		case .available: nil
		case .systemTooOld: "The operator needs \(platform.systemName) 26 or later."
		case .platformUnsupported: "This device has no on-device model to run the operator."
		case .deviceNotEligible: "This device cannot run Apple Intelligence."
		case .notReady: "Turn on Apple Intelligence in \(platform.settingsApp), then try again."
		}
	}
}

/// deck's voice operator, thinking on the device rather than on the deck
/// machine. It holds a conversation with Apple's on-device model, which calls
/// deck's agent API through the tools in OperatorTools.swift to answer a
/// question or carry out an instruction.
///
/// This replaced a model running beside deck on the user's Mac. The tools are
/// the same seven; what changed is that the deciding happens on the phone, so
/// there is nothing to install, nothing resident on the Mac, and the whole
/// conversation stays on the device.
///
/// The conversation is per-device, which the server operator's shared log was
/// not. That is the trade for having no model to run.
@MainActor
public final class OperatorBrain {
	private let client: DeckClient
	private var session: Any?
	private var instructionsBuiltAt: Date?

	/// A downloaded model to think with instead of Apple's own (deck#239).
	///
	/// Type-erased on purpose. The protocol it conforms to is newer than this
	/// package's floor, and DeckKit must not link MLX: the watch app, the
	/// widgets and the share extension all link DeckKit and none of them runs a
	/// model. The app builds the thing (see DeckLocalModel) and hands it over;
	/// everything here casts it behind an availability check.
	private var custom: Any?
	/// Which model `custom` is, so a reconfigure with the same one is a no-op.
	private var customId = ""

	/// What a tool may hand back, which follows whichever model is answering.
	/// Apple's window is 4,096 tokens; a downloaded model's is tens of
	/// thousands, and cutting a reply to fit the smaller one would be throwing
	/// away the answer for nothing.
	private var limits: OperatorLimits = .appleOnDevice

	/// Rebuild the instructions when they are this stale: they name the
	/// projects and skills, which change as the user registers and writes them.
	private static let instructionsTTL: TimeInterval = 10 * 60

	public init(client: DeckClient) {
		self.client = client
	}

	/// Think with a downloaded model, or pass nil to go back to Apple's own.
	///
	/// `id` is what tells the brain whether the model really changed: it cannot
	/// compare the models themselves, which are structs, and the app hands the
	/// same one over again on every reconfigure.
	///
	/// A change starts the conversation again, because a transcript carries the
	/// instructions and tool exchanges of whichever model produced it and does
	/// not transfer to another one.
	public func useModel(_ model: Any?, id: String = "") {
		let next = model == nil ? "" : id
		custom = model
		limits = model == nil ? .appleOnDevice : .downloaded
		guard next != customId else { return }
		customId = next
		reset()
	}

	/// Whether a downloaded model is answering rather than Apple's.
	public var usesDownloadedModel: Bool { custom != nil }

	public static var availability: OperatorAvailability {
		#if canImport(FoundationModels) && !os(watchOS)
		if #available(iOS 26.0, macOS 26.0, visionOS 26.0, *) {
			return currentAvailability()
		}
		return .systemTooOld
		#else
		return .platformUnsupported
		#endif
	}

	/// Ask the operator something. Returns what to say back.
	public func send(_ text: String) async throws -> String {
		#if canImport(FoundationModels) && !os(watchOS)
		if #available(iOS 26.0, macOS 26.0, visionOS 26.0, *) {
			return try await respond(to: text)
		}
		throw DeckError.notConfigured
		#else
		throw DeckError.notConfigured
		#endif
	}

	/// Start a fresh conversation. The next ask rebuilds the instructions too,
	/// so a session started since the last one is known about.
	public func reset() {
		session = nil
		instructionsBuiltAt = nil
	}

	/// A one-sentence summary of a finished turn, for the operator to read out.
	/// Asked on its own session so a summary never lands in the conversation
	/// the user is having.
	public func summarise(reply: String, sessionTitle: String) async throws -> String {
		#if canImport(FoundationModels) && !os(watchOS)
		if #available(iOS 26.0, macOS 26.0, visionOS 26.0, *) {
			return try await summary(of: reply, from: sessionTitle)
		}
		throw DeckError.notConfigured
		#else
		throw DeckError.notConfigured
		#endif
	}
}

#if canImport(FoundationModels) && !os(watchOS)
import FoundationModels

@available(iOS 26.0, macOS 26.0, visionOS 26.0, *)
extension OperatorBrain {
	fileprivate static func currentAvailability() -> OperatorAvailability {
		switch SystemLanguageModel.default.availability {
		case .available: .available
		case .unavailable(.deviceNotEligible): .deviceNotEligible
		case .unavailable: .notReady
		}
	}

	fileprivate func respond(to text: String) async throws -> String {
		do {
			let reply = try await liveSession().respond(to: text)
			return reply.content.trimmingCharacters(in: .whitespacesAndNewlines)
		} catch LanguageModelSession.GenerationError.exceededContextWindowSize {
			// The whole window is 4,096 tokens, so a long conversation fills it
			// however small each tool result is. Drop the oldest history and ask
			// again rather than ending the turn with "Provided 4,099 tokens, but
			// the maximum allowed is 4,096", which is true and useless.
			trimHistory()
			let reply = try await liveSession().respond(to: text)
			return reply.content.trimmingCharacters(in: .whitespacesAndNewlines)
		}
	}

	/// Keep the most recent exchanges and throw the rest away. Losing the start
	/// of a conversation beats losing the answer.
	private func trimHistory() {
		guard let previous = session as? LanguageModelSession else { return }
		let keep = 4
		let entries = Array(previous.transcript.suffix(keep))
		session = entries.isEmpty
			? nil
			: makeSession(transcript: FoundationModels.Transcript(entries: entries))
		// Force the next liveSession() to rebuild with fresh instructions: a
		// trimmed transcript may no longer carry them.
		instructionsBuiltAt = nil
	}

	fileprivate func summary(of reply: String, from sessionTitle: String) async throws -> String {
		// No tools: this asks the model to read, not to act.
		let brief = "Summarise a coding agent's reply in one short spoken sentence. Plain text, no markdown, no lists."
		let summariser: LanguageModelSession
		if #available(iOS 27.0, macOS 27.0, visionOS 27.0, *),
			let model = custom as? any FoundationModels.LanguageModel {
			summariser = LanguageModelSession(model: model, instructions: brief)
		} else {
			summariser = LanguageModelSession(instructions: brief)
		}
		let response = try await summariser.respond(
			to: "\(sessionTitle) finished a turn and said:\n\n\(reply)")
		return response.content.trimmingCharacters(in: .whitespacesAndNewlines)
	}

	/// A session on the chosen model. The `model:` initialiser only exists from
	/// iOS 27, which is when Apple let anything but their own model back a
	/// session, so an older OS always gets the system one however it is set.
	private func makeSession(instructions: String) -> LanguageModelSession {
		let tools = client.operatorTools(limits: limits)
		if #available(iOS 27.0, macOS 27.0, visionOS 27.0, *),
			let model = custom as? any FoundationModels.LanguageModel {
			return LanguageModelSession(model: model, tools: tools, instructions: instructions)
		}
		return LanguageModelSession(tools: tools, instructions: instructions)
	}

	private func makeSession(transcript: FoundationModels.Transcript) -> LanguageModelSession {
		let tools = client.operatorTools(limits: limits)
		if #available(iOS 27.0, macOS 27.0, visionOS 27.0, *),
			let model = custom as? any FoundationModels.LanguageModel {
			return LanguageModelSession(model: model, tools: tools, transcript: transcript)
		}
		return LanguageModelSession(tools: tools, transcript: transcript)
	}

	private func liveSession() async throws -> LanguageModelSession {
		let fresh = instructionsBuiltAt.map { Date().timeIntervalSince($0) < Self.instructionsTTL } ?? false
		if fresh, let existing = session as? LanguageModelSession { return existing }

		let built = makeSession(instructions: try await instructions())
		// Carry the conversation over a rebuild, so refreshing the projects and
		// skills mid-chat does not lose what was just said.
		let carried: LanguageModelSession
		if let previous = session as? LanguageModelSession, !previous.transcript.isEmpty {
			carried = makeSession(transcript: previous.transcript)
		} else {
			carried = built
		}
		session = carried
		instructionsBuiltAt = Date()
		return carried
	}

	/// What the model is told before anything is said. Deliberately short: the
	/// on-device model re-reads this every turn, with no prompt cache to hide
	/// the cost, so anything that can be a tool call is one. Naming this
	/// machine's 142 skills here cost 12.4 seconds a turn against 1.4 without
	/// them (see ListSkillsTool).
	private func instructions() async throws -> String {
		let projects = ((try? await client.projects()) ?? []).map(\.name)

		return """
			You are deck's voice operator. deck runs coding agents (claude and others) in sessions on \
			the user's machine; the user is hands-free and hears you through text to speech.

			Anything about the sessions means calling a tool and answering from what comes back, \
			never from memory and never by saying what you are able to do. "What are my sessions \
			doing", "catch me up", "what has been happening", "how is it going", "what did it say" \
			all mean: call list_sessions, and latest_reply for a session's own reply.

			Only when asked what *you* can do, with no session in the question, say: "I can tell you \
			what your sessions are doing, read or summarise a reply, send a session an instruction, \
			answer a question one is waiting on, stop a turn, or start a new session." That one \
			sentence is the only reply you ever give without calling a tool first.

			Rules: reply in one or two short spoken sentences, plain text, no markdown, no lists. Act \
			with the tools rather than describing what you would do. Refer to sessions by their titles \
			when speaking and by id when calling tools; never invent an id. If more than one session \
			could be meant, ask which. Never say ids or field names aloud. Read a reply in full only \
			when asked to hear all of it; otherwise give its gist in a sentence. Before start_session, \
			say what you would start and wait for agreement.

			The user can run skills. You do not know their names: call list_skills when \
			they mention one or ask what can be run, and skill_details to say what one does. \
			A session runs a skill when the message you send is "run <skill> <arguments>".

			Projects: \(projects.isEmpty ? "none" : projects.joined(separator: ", ")).
			"""
	}

}
#endif
