import Foundation

/// A timer an agent set through deck's MCP server, with an optional check
/// command run once when it falls due (`src/lib/watches.ts`). Sessions carry
/// their active ones on the digest; `GET /api/agent/watches` lists them all.
public struct Watch: Codable, Hashable, Identifiable, Sendable {
	public enum State: String, Codable, Sendable {
		case active, fired, cancelled, unknown

		public init(from decoder: Decoder) throws {
			let raw = try decoder.singleValueContainer().decode(String.self)
			self = State(rawValue: raw) ?? .unknown
		}
	}

	public let id: String
	public let sessionId: String
	public let title: String
	public let prompt: String
	public let command: String?
	/// Epoch milliseconds, like every other deck timestamp.
	public let createdAt: Double
	public let dueAt: Double
	public let state: State
	public let endedAt: Double?
	public let result: WatchResult?

	public init(
		id: String, sessionId: String, title: String, prompt: String = "", command: String? = nil,
		createdAt: Double, dueAt: Double, state: State = .active, endedAt: Double? = nil, result: WatchResult? = nil
	) {
		self.id = id
		self.sessionId = sessionId
		self.title = title
		self.prompt = prompt
		self.command = command
		self.createdAt = createdAt
		self.dueAt = dueAt
		self.state = state
		self.endedAt = endedAt
		self.result = result
	}

	public var dueDate: Date { Date(timeIntervalSince1970: dueAt / 1000) }
}

public struct WatchResult: Codable, Hashable, Sendable {
	/// Nil when the check was killed or could not start.
	public let exitCode: Int?
	public let output: String
	public let timedOut: Bool?
}

/// One row of the activity list after a session's last bubble: an active
/// watch or a subagent. Mirrors the web's `activity-core.ts`.
public enum ActivityEntry: Identifiable, Equatable, Sendable {
	case watch(Watch)
	case agent(SubagentState)

	public var id: String {
		switch self {
		case .watch(let watch): return "w:\(watch.id)"
		case .agent(let agent): return "a:\(agent.taskId)"
		}
	}
}

public enum ActivityFeed {
	public static let cap = 3

	/// Watches and agents together, newest first. `agentStart` gives when an
	/// agent began, in epoch ms: the server's fold carries no start time.
	public static func entries(
		watches: [Watch], agents: [SubagentState], agentStart: (SubagentState) -> Double
	) -> [ActivityEntry] {
		let dated = watches.map { (at: $0.createdAt, entry: ActivityEntry.watch($0)) }
			+ agents.map { (at: agentStart($0), entry: ActivityEntry.agent($0)) }
		return dated.sorted { $0.at > $1.at }.map(\.entry)
	}

	/// The first three until expanded, and how many more there are.
	public static func visible(_ entries: [ActivityEntry], expanded: Bool) -> (shown: [ActivityEntry], more: Int) {
		if expanded || entries.count <= cap { return (entries, 0) }
		return (Array(entries.prefix(cap)), entries.count - cap)
	}

	/// `4m 12s`, `1h 3m`, `due` once the time has come.
	public static func countdown(_ ms: Double) -> String {
		ms <= 0 ? "due" : SubagentState.duration(Int((ms / 1000).rounded(.up)) * 1000)
	}
}
