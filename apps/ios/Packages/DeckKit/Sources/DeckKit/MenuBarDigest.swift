import Foundation

/// What the Mac's menu bar extra shows: the questions waiting on you, the
/// runs that are blocked, and what is running, plus the count on its icon.
public struct MenuBarDigest: Equatable, Sendable {
	public struct Waiting: Equatable, Identifiable, Sendable {
		public var id: String { ask.id }
		public let ask: DeckAsk
		/// The session's title, or the run's for a blocked run.
		public let title: String
		/// The first question's text, what the row says is being asked.
		public let question: String?
		/// The labels a one-click answer can pick: set only for a single
		/// question that takes one option.
		public let quickOptions: [String]
		/// The session the row opens. Nil for a run with no phase session yet.
		public let sessionId: String?
	}

	public let questions: [Waiting]
	public let blockedRuns: [Waiting]
	/// Running sessions not already listed as waiting, most recent first.
	public let running: [SessionDigest]

	public init(asks: [DeckAsk], sessions: [SessionDigest], runs: [RunDigest]) {
		let sessionsById = Dictionary(sessions.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
		let runsById = Dictionary(runs.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
		questions = asks.filter { $0.runId == nil }.map { ask in
			Self.waiting(ask, title: sessionsById[ask.sessionId].map(Self.title(of:)) ?? ask.sessionId)
		}
		blockedRuns = asks.compactMap { ask in
			guard let runId = ask.runId else { return nil }
			return Self.waiting(ask, title: runsById[runId]?.title ?? ask.questions.first?.header ?? "Blocked run")
		}
		let waitingIds = Set(asks.map(\.sessionId))
		running = sessions
			.filter { $0.status == .running && $0.hidden != true && !waitingIds.contains($0.id) }
			.sorted { ($0.lastActiveAt ?? 0) > ($1.lastActiveAt ?? 0) }
	}

	/// Everything that needs you.
	public var count: Int { questions.count + blockedRuns.count }

	/// The icon's count: nothing when nothing needs you, capped so the menu
	/// bar item stays narrow.
	public var badge: String? {
		switch count {
		case 0: return nil
		case 1...9: return String(count)
		default: return "9+"
		}
	}

	public var isEmpty: Bool { count == 0 && running.isEmpty }

	/// The options a single-choice question can be answered with in one
	/// click. Anything else (several questions, multi-select, free text) opens
	/// the session to answer there.
	public static func quickOptions(_ ask: DeckAsk) -> [String] {
		guard ask.runId == nil, ask.questions.count == 1, let question = ask.questions.first,
			question.multiSelect != true else { return [] }
		return (question.options ?? []).map(\.label)
	}

	private static func waiting(_ ask: DeckAsk, title: String) -> Waiting {
		// A run with no phase session yet carries its own id in sessionId.
		let sessionId = ask.runId == ask.sessionId ? nil : ask.sessionId
		return Waiting(
			ask: ask, title: title, question: ask.questions.first?.question,
			quickOptions: quickOptions(ask), sessionId: sessionId)
	}

	/// A session's title, else the folder it works in, else its id.
	public static func title(of session: SessionDigest) -> String {
		if let title = session.title, !title.isEmpty { return title }
		if let cwd = session.cwd { return (cwd as NSString).lastPathComponent }
		return session.id
	}
}
