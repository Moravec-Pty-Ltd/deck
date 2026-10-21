import Foundation

/// One subagent of a session, as deck folds it from claude's `system` task
/// events (`GET /api/agent/sessions/{id}/agents`, the `subagents` capability).
public struct SubagentState: Decodable, Equatable, Sendable {
	public enum Status: String, Decodable, Sendable {
		case running, completed, failed, stopped
	}

	public let taskId: String
	/// The Agent call that launched it, the card its steps fold into.
	public let toolUseId: String
	public let description: String
	public let subagentType: String
	public let background: Bool
	public let status: Status
	/// What it is doing right now, from its latest progress report.
	public let activity: String
	public let tokens: Int
	public let toolUses: Int
	public let durationMs: Int
	/// Its final report. A background agent's call result is only a launch
	/// receipt, so this is where its answer lands.
	public let summary: String

	public init(
		taskId: String, toolUseId: String, description: String = "", subagentType: String = "",
		background: Bool = false, status: Status, activity: String = "", tokens: Int = 0,
		toolUses: Int = 0, durationMs: Int = 0, summary: String = ""
	) {
		self.taskId = taskId
		self.toolUseId = toolUseId
		self.description = description
		self.subagentType = subagentType
		self.background = background
		self.status = status
		self.activity = activity
		self.tokens = tokens
		self.toolUses = toolUses
		self.durationMs = durationMs
		self.summary = summary
	}

	public var isRunning: Bool { status == .running }

	/// `1m 26s · 5 tools · 56k tokens`, the web card's progress line.
	public var progress: String {
		var parts: [String] = []
		if durationMs > 0 { parts.append(Self.duration(durationMs)) }
		if toolUses > 0 { parts.append(toolUses == 1 ? "1 tool" : "\(toolUses) tools") }
		if tokens > 0 { parts.append("\(SessionContext.tokens(tokens)) tokens") }
		return parts.joined(separator: " · ")
	}

	/// `42s`, `1m 26s`, `2h 5m`, matching the web's formatDuration.
	public static func duration(_ ms: Int) -> String {
		let s = max(0, Int((Double(ms) / 1000).rounded()))
		if s < 60 { return "\(s)s" }
		let m = s / 60
		if m < 60 { return "\(m)m \(s % 60)s" }
		return "\(m / 60)h \(m % 60)m"
	}
}

/// Every subagent of a session, by task id, with the launching call's index.
public struct SubagentsState: Decodable, Equatable, Sendable {
	public let tasks: [String: SubagentState]
	/// Launching call id to task id.
	public let byCall: [String: String]

	public init(tasks: [String: SubagentState] = [:], byCall: [String: String] = [:]) {
		self.tasks = tasks
		self.byCall = byCall
	}

	public func agent(forCall id: String) -> SubagentState? {
		byCall[id].flatMap { tasks[$0] }
	}

	public var running: [SubagentState] {
		tasks.values.filter(\.isRunning).sorted { $0.taskId < $1.taskId }
	}

	/// Whether a live event can change what this holds, so a client refetches
	/// the server's fold rather than folding claude's task events itself.
	public static func affects(_ event: JSONValue) -> Bool {
		switch event["type"].string {
		case "system":
			let subtype = event["subtype"].string ?? ""
			return subtype.hasPrefix("task_") || subtype == "background_tasks_changed"
		case "result":
			return (event["parent_tool_use_id"].string ?? "").isEmpty
		case "deck.restart":
			return true
		default:
			return false
		}
	}
}

extension DeckClient {
	/// The session's subagents, each with its full report.
	public func sessionAgents(sessionId: String) async throws -> SubagentsState {
		try await get("/api/agent/sessions/\(sessionId)/agents")
	}
}
