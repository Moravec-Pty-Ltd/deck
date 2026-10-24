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

	/// The voice screen's states, at most the five CarPlay allows.
	public enum VoiceState: String, CaseIterable, Sendable {
		case ready, listening, thinking, speaking

		public static func of(_ status: VoiceController.Status, working: Bool) -> VoiceState {
			switch status {
			case .listening: .listening
			case .transcribing: .thinking
			case .speaking: .speaking
			case .idle: working ? .thinking : .ready
			}
		}

		public var title: String {
			switch self {
			case .ready: "Tap Talk to speak"
			case .listening: "Listening, tap Send when done"
			case .thinking: "Working on it"
			case .speaking: "Speaking"
			}
		}

		/// The one action button's label: a take in progress is ended by it.
		public var buttonTitle: String { self == .listening ? "Send" : "Talk" }
	}
}
