import Foundation

/// What the phone's home-screen widget shows, the StandBy one included: how
/// many questions and blocked runs wait and how much is running, and the first
/// thing waiting with the options it can be answered with from the widget.
/// Codable so the widget can keep the last one it read and show its age when
/// deck can't be reached.
public struct DeckGlance: Codable, Equatable, Sendable {
	public struct First: Codable, Equatable, Sendable {
		public let title: String
		public let question: String?
		/// The session tapping the widget opens; nil for a run with no phase
		/// session yet.
		public let sessionId: String?
		public let askId: String?
		public let header: String
		/// Buttons the widget offers. Empty when the question can't be answered
		/// with one tap, or has more options than fit, so the tap opens the
		/// session instead of hiding a choice.
		public let options: [String]
	}

	/// More buttons than this won't fit on a small widget.
	public static let maxOptions = 3

	public let questions: Int
	public let blockedRuns: Int
	public let running: Int
	public let first: First?
	public let fetchedAt: Date

	public init(_ digest: MenuBarDigest, at date: Date) {
		questions = digest.questions.count
		blockedRuns = digest.blockedRuns.count
		running = digest.running.count
		fetchedAt = date
		first = (digest.questions + digest.blockedRuns).first.map { item in
			let question = item.ask.questions.first
			return First(
				title: item.title, question: item.question, sessionId: item.sessionId, askId: item.ask.askId,
				header: question?.header ?? question?.question ?? "Answer",
				// Without the ask's id deck can't tell a stale tap from an answer to the
				// session's next question, so that one opens the session instead.
				options: item.ask.askId != nil && item.quickOptions.count <= Self.maxOptions ? item.quickOptions : [])
		}
	}

	/// The link the widget opens: the first waiting session, else the app.
	public var url: URL? {
		first?.sessionId.flatMap { URL(string: "deck://s/\($0)") }
	}

	/// The answer one of the first question's buttons posts, the same one the
	/// notification's option action sends.
	public func answer(_ label: String) -> NotificationAnswer? {
		guard let first, let sessionId = first.sessionId, first.options.contains(label) else { return nil }
		return NotificationAnswer(
			sessionId: sessionId, runId: nil, askId: first.askId, header: first.header, label: label, structured: true)
	}
}
