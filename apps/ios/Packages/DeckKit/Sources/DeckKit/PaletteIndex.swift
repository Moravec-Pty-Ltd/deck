import Foundation

/// Something the command palette can run that is not a session: open a
/// screen, start a session, stop a turn. The app decides what each does; this
/// only names it so the palette can find it.
public struct PaletteAction: Identifiable, Hashable, Sendable {
	public let id: String
	public let title: String
	/// More words the action answers to beyond its title.
	public let keywords: [String]
	/// The keyboard shortcut that runs it too, shown beside it ("⌘N").
	public let shortcut: String?
	/// An SF Symbol name.
	public let systemImage: String

	public init(id: String, title: String, keywords: [String] = [], shortcut: String? = nil, systemImage: String) {
		self.id = id
		self.title = title
		self.keywords = keywords
		self.shortcut = shortcut
		self.systemImage = systemImage
	}
}

extension PaletteAction {
	public static let newSession = PaletteAction(
		id: "new-session", title: "New session", keywords: ["create", "add", "start"],
		shortcut: "⌘N", systemImage: "plus.circle")
	public static let searchSessions = PaletteAction(
		id: "search-sessions", title: "Search sessions", keywords: ["find", "history", "said", "transcripts", "name"],
		shortcut: "⌘F", systemImage: "magnifyingglass")
	public static let stopTurn = PaletteAction(
		id: "stop-turn", title: "Stop the running turn", keywords: ["interrupt", "cancel", "halt"],
		shortcut: "⌘.", systemImage: "stop.circle")
	public static let previousSession = PaletteAction(
		id: "previous-session", title: "Previous session", keywords: ["up", "back", "switch"],
		shortcut: "⌘[", systemImage: "chevron.up")
	public static let nextSession = PaletteAction(
		id: "next-session", title: "Next session", keywords: ["down", "forward", "switch"],
		shortcut: "⌘]", systemImage: "chevron.down")
	public static let inbox = PaletteAction(
		id: "inbox", title: "Inbox", keywords: ["runs", "asks", "questions", "waiting"],
		systemImage: "tray")
	public static let voiceOperator = PaletteAction(
		id: "operator", title: "Operator", keywords: ["voice", "talk", "speak"],
		systemImage: "waveform")
	public static let browser = PaletteAction(
		id: "browser", title: "Browser", keywords: ["web", "dev server", "preview"],
		systemImage: "globe")
	public static let settings = PaletteAction(
		id: "settings", title: "Settings", keywords: ["preferences", "server", "projects", "pair"],
		systemImage: "gearshape")
}

/// One line in the palette.
public enum PaletteItem: Identifiable, Hashable, Sendable {
	case action(PaletteAction)
	case session(SessionDigest)

	public var id: String {
		switch self {
		case .action(let action): "action:\(action.id)"
		case .session(let session): "session:\(session.id)"
		}
	}
}

/// What the command palette lists for what was typed. Sessions match the same
/// way the sessions list's search does (SessionSearch), and actions match on
/// their title and keywords by the same rule, so the two rank on one scale.
public struct PaletteIndex: Sendable {
	public let actions: [PaletteAction]
	public let sessions: [SessionDigest]

	public init(actions: [PaletteAction], sessions: [SessionDigest]) {
		self.actions = actions
		self.sessions = sessions
	}

	/// Best first: exact, then prefix, then the rest, and an action ahead of a
	/// session that ranks the same, as on the web. Callers' order survives
	/// within a rank. Too short a query lists everything, actions first, so the
	/// palette is never blank while you are still typing.
	public func results(for text: String) -> [PaletteItem] {
		let all = actions.map(PaletteItem.action) + sessions.map(PaletteItem.session)
		guard let query = SessionSearch.Query(text) else { return all }
		let ranked = all.enumerated().compactMap { index, item -> (Int, Int, PaletteItem)? in
			guard let rank = Self.rank(item, against: query) else { return nil }
			return (rank, index, item)
		}
		return ranked
			.sorted { $0.0 != $1.0 ? $0.0 < $1.0 : $0.1 < $1.1 }
			.map(\.2)
	}

	/// The highlighted row kept on the results: `offset` moved `by` rows, held
	/// to the list so a shrinking result set never leaves it past the end.
	public static func highlight(_ offset: Int, by: Int = 0, count: Int) -> Int {
		guard count > 0 else { return 0 }
		return min(max(offset + by, 0), count - 1)
	}

	private static func rank(_ item: PaletteItem, against query: SessionSearch.Query) -> Int? {
		switch item {
		case .action(let action):
			SessionSearch.rank(action.title, against: query, extra: action.keywords.joined(separator: " "))
		case .session(let session):
			SessionSearch.rank(session, against: query)
		}
	}
}

/// Stepping through sessions in list order, for previous and next.
public enum SessionStepper {
	/// The session `offset` places from `current` in `ids`, or nil past either
	/// end. With nothing open, or the open one not in the list, next starts at
	/// the top and previous at the bottom.
	public static func step(from current: String?, by offset: Int, in ids: [String]) -> String? {
		guard !ids.isEmpty, offset != 0 else { return nil }
		guard let current, let index = ids.firstIndex(of: current) else {
			return offset > 0 ? ids.first : ids.last
		}
		let target = index + offset
		return ids.indices.contains(target) ? ids[target] : nil
	}
}
