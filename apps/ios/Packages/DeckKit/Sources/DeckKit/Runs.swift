import Foundation

// Workflow runs (deck's GET /api/agent/runs digest, issue deck#233). deck owns
// the state machine: the client renders a digest and posts actions, and never
// moves a run between phases itself. Every documented field is decoded, used
// or not, since a field one end drops is how the clients drift apart.

public enum RunStatus: String, Codable, Sendable, CaseIterable {
	case running, waiting, paused, blocked, done, cancelled, unknown

	public init(from decoder: Decoder) throws {
		let raw = try decoder.singleValueContainer().decode(String.self)
		self = RunStatus(rawValue: raw) ?? .unknown
	}

	/// A run in one of these never moves again on its own.
	public var isFinished: Bool { self == .done || self == .cancelled }

	/// What a person reads on the board.
	public var label: String {
		switch self {
		case .running: return "running"
		case .waiting: return "waiting on review"
		case .paused: return "paused"
		case .blocked: return "needs you"
		case .done: return "done"
		case .cancelled: return "cancelled"
		case .unknown: return "unknown"
		}
	}
}

public enum PhaseStatus: String, Codable, Sendable {
	case pending, active, pass, fail, skipped, unknown

	public init(from decoder: Decoder) throws {
		let raw = try decoder.singleValueContainer().decode(String.self)
		self = PhaseStatus(rawValue: raw) ?? .unknown
	}
}

public struct RunWorkflow: Codable, Hashable, Sendable {
	public let id: String
	public let name: String
	/// "dev" or "review".
	public let category: String
}

public struct RunPR: Codable, Hashable, Sendable {
	public let repo: String
	public let number: Int
	public let url: String?
	public let title: String?
	public let baseRefName: String?
}

/// One review finding, as dev-review emits it.
public struct RunFinding: Codable, Hashable, Sendable {
	public let file: String
	public let line: Int?
	public let severity: String
	public let defect: String
	public let fix: String?
	public let keep: String?
}

public struct RunEscalations: Codable, Hashable, Sendable {
	public let implementer: Bool
	public let disagreement: Bool
	public let cap: Bool
}

/// One visit to a phase. A looping phase has one per round.
public struct PhaseSession: Codable, Hashable, Sendable {
	/// Absent for a command step (verify), which runs no session.
	public let sessionId: String?
	public let visit: Int
	/// pass | fail | error | skipped | interrupted; absent while it runs.
	public let result: String?
	public let detail: String?
	public let startedAt: Double
	public let endedAt: Double?
	/// A person drove this session during a take-over.
	public let humanTouched: Bool?
}

/// A call made on a run, by the overseer, a person, or the engine, and why.
public struct RunDecision: Codable, Hashable, Sendable {
	public let at: Double
	public let by: String
	public let step: String
	public let action: String
	public let reason: String
}

public struct RunPhase: Codable, Hashable, Identifiable, Sendable {
	public let id: String
	public let label: String
	public let role: String
	public let status: PhaseStatus
	/// Times this phase has run. Looping phases climb.
	public let visits: Int
	public let cap: Int?
	public let next: String
	public let onFail: String?
	public let sessions: [PhaseSession]
	public let decisions: [RunDecision]
}

/// The question a blocked run waits on.
public struct RunBlock: Codable, Hashable, Sendable {
	public let question: String
	public let at: Double
	public let by: String
	public let step: String
}

/// The intent note left by whoever drove a phase last.
public struct RunHandoff: Codable, Hashable, Sendable {
	public let text: String
	public let tree: String
	public let at: Double
}

public struct RunDigest: Codable, Hashable, Identifiable, Sendable {
	public let id: String
	public let url: String?
	public let workflow: RunWorkflow
	public let title: String
	public let projectPath: String
	public let cwd: String
	public let branch: String
	public let base: String?
	public let issue: DeckIssue?
	public let pr: RunPR?
	public let status: RunStatus
	/// The id of the phase the run is on.
	public let phase: String
	/// Review rounds so far.
	public let round: Int
	public let cap: Int?
	public let loop: Bool
	public let blockers: Int
	public let findings: [RunFinding]
	public let escalations: RunEscalations
	public let humanTouched: Bool
	public let phases: [RunPhase]
	public let block: RunBlock?
	public let handoff: RunHandoff?
	public let error: String?
	public let createdAt: Double
	public let updatedAt: Double
	/// Single-run reads only: the working tree moved since the handoff note.
	public let handoffStale: Bool?
	/// A fix-findings follow-up is running (or ran) on this finished run.
	public let followUp: Bool?

	/// A finished dev run that opened a PR but left findings behind can be sent
	/// back to fix them. The dev-category check mirrors deck's rule so the button
	/// only shows where it can work; deck still decides (a merged PR is a 409).
	public var canFixFindings: Bool {
		status == .done && workflow.category == "dev" && pr != nil && !findings.isEmpty
	}

	public var currentPhase: RunPhase? { phases.first { $0.id == phase } }

	/// The session a take-over drives and a blocked run's answer lands on: the
	/// latest visit of the current phase, else the latest visit anywhere.
	public var latestSessionId: String? {
		if let id = currentPhase?.sessions.last(where: { $0.sessionId != nil })?.sessionId { return id }
		return phases.flatMap(\.sessions).filter { $0.sessionId != nil }.max { $0.startedAt < $1.startedAt }?.sessionId
	}

	/// The repo-ish name a board row leads with.
	public var projectName: String {
		projectPath.split(separator: "/").last.map(String.init) ?? projectPath
	}

	/// A blocked run as an ask, so the inbox, the watch, and notifications
	/// answer it the way they answer a session's question. Nil unless blocked.
	public var ask: DeckAsk? {
		guard status == .blocked, let block else { return nil }
		return DeckAsk(
			sessionId: latestSessionId ?? id, source: "run", runId: id, askedAt: block.at,
			questions: [AskQuestion(question: block.question, header: title)])
	}
}

/// The long-lived session deck wakes when a run blocks, errors, or finishes
/// (GET /api/agent/overseer).
public struct Overseer: Codable, Hashable, Sendable {
	public let sessionId: String?
	/// An overseer is watching.
	public let active: Bool
	/// It is mid-turn.
	public let busy: Bool
}

/// A workflow deck can run, as GET /api/agent/workflows lists them. `steps` is
/// deliberately not decoded: starting a run names the workflow, and the phases
/// come back on the digest.
public struct WorkflowDef: Codable, Hashable, Identifiable, Sendable {
	public let id: String
	public let name: String
	public let category: String
	/// The one this category starts by default.
	public let isDefault: Bool?

	enum CodingKeys: String, CodingKey {
		case id, name, category
		case isDefault = "default"
	}

	public var isReview: Bool { category == "review" }
}

public struct WorkflowsResponse: Codable, Sendable {
	public let workflows: [WorkflowDef]
	/// User definitions deck skipped as malformed, worth showing rather than
	/// leaving someone wondering where their workflow went.
	public let problems: [String]?
}

/// Grouping and defaults for the workflow picker, so the app and the web agree
/// on what is offered first.
public enum WorkflowPicker {
	public static func grouped(_ workflows: [WorkflowDef]) -> [(category: String, workflows: [WorkflowDef])] {
		let byCategory = Dictionary(grouping: workflows, by: \.category)
		return byCategory.keys.sorted().map { (category: $0, workflows: byCategory[$0]!.sorted { $0.name < $1.name }) }
	}

	/// What a fresh form selects: the default dev workflow, else any dev one,
	/// else whatever there is. Dev leads because starting from an issue is the
	/// common case; a review run usually starts from the PR itself.
	public static func initial(_ workflows: [WorkflowDef]) -> WorkflowDef? {
		workflows.first { $0.isDefault == true && !$0.isReview }
			?? workflows.first { !$0.isReview }
			?? workflows.first
	}
}

/// The actions deck takes on a run (POST /api/agent/runs/{id}/{action}).
public enum RunAction: String, Sendable {
	case pause, takeover, resume, retry, cancel, answer
	case fixFindings = "fix-findings"
}

public enum RunBoard {
	/// Board order: what needs you first, then what is moving, then what is
	/// finished; newest change first within each.
	public static func sorted(_ runs: [RunDigest]) -> [RunDigest] {
		runs.sorted {
			let (a, b) = (rank($0.status), rank($1.status))
			return a != b ? a < b : $0.updatedAt > $1.updatedAt
		}
	}

	private static func rank(_ status: RunStatus) -> Int {
		switch status {
		case .blocked: return 0
		case .paused: return 1
		case .running, .waiting, .unknown: return 2
		case .done, .cancelled: return 3
		}
	}
}
