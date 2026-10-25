import Foundation

/// What the CarPlay screens show, kept apart from CarPlay so it can be tested.
public enum CarPlayHome {
	/// The sessions under Operator on the CarPlay home list: the app's list
	/// (already most recent first) without terminals, which have no voice mode,
	/// those with an open question moved to the top, cut to `limit` rows.
	public static func sessions(_ active: [SessionDigest], asks: [DeckAsk], limit: Int) -> [SessionDigest] {
		let asking = Set(asks.map(\.sessionId))
		let agents = active.filter { $0.kind != "shell" }
		let isAsking = { (session: SessionDigest) in asking.contains(session.id) || session.awaitingInput == true }
		return Array((agents.filter(isAsking) + agents.filter { !isAsking($0) }).prefix(max(0, limit)))
	}

	/// The voice screen's states. Hands-free and tap to talk each use five
	/// or fewer, the most CarPlay allows.
	public enum VoiceState: String, Sendable {
		/// Tap to talk, waiting for a tap.
		case ready
		/// Hands-free, waiting for speech.
		case listening
		/// A take is being captured.
		case hearing
		case thinking, speaking
		/// Hands-free, with the mic closed.
		case paused

		/// What the one button does in a state.
		public enum Tap: Sendable { case talk, send, pause, resume }

		public static func states(handsFree: Bool) -> [VoiceState] {
			handsFree ? [.listening, .hearing, .thinking, .speaking, .paused] : [.ready, .hearing, .thinking, .speaking]
		}

		public static func of(_ status: VoiceController.Status, recording: Bool, working: Bool, handsFree: Bool) -> VoiceState {
			if recording { return .hearing }
			switch status {
			case .listening: return working ? .thinking : .listening
			case .transcribing: return .thinking
			case .speaking: return .speaking
			// Hands-free and not listening: paused, or the mic hasn't opened yet.
			case .idle: return handsFree ? .paused : working ? .thinking : .ready
			}
		}

		public var title: String {
			switch self {
			case .ready: "Tap Talk to speak"
			case .listening, .hearing: "Listening"
			case .thinking: "Working on it"
			case .speaking: "Speaking"
			case .paused: "Paused, tap to resume"
			}
		}

		public func tap(handsFree: Bool) -> Tap {
			switch self {
			case .hearing: .send
			case .paused: .resume
			case .ready: .talk
			case .listening, .thinking, .speaking: handsFree ? .pause : .talk
			}
		}

		public func buttonTitle(handsFree: Bool) -> String {
			switch tap(handsFree: handsFree) {
			case .talk: "Talk"
			case .send: "Send"
			case .pause: "Pause"
			case .resume: "Resume"
			}
		}
	}
}
