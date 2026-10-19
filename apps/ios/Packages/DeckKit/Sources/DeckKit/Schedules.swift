import Foundation

// Schedules (deck's GET /api/agent/schedules digest, issue deck#235): a prompt
// that runs on a clock. deck owns the clock and the cron expression; the client
// renders the digest, posts edits, and asks what an expression would do rather
// than working it out itself.

/// What became of a schedule's last run.
public enum ScheduleOutcome: String, Codable, Sendable {
	/// The prompt went to an agent.
	case ran
	/// Passed over on purpose: the last run was still going, or the window went
	/// by while deck was down. The schedule is healthy.
	case skipped
	/// Something was wrong, and `lastNote` says what.
	case failed
	case unknown

	public init(from decoder: Decoder) throws {
		let raw = try decoder.singleValueContainer().decode(String.self)
		self = ScheduleOutcome(rawValue: raw) ?? .unknown
	}

	public var label: String {
		switch self {
		case .ran: return "Ran"
		case .skipped: return "Skipped"
		case .failed: return "Failed"
		case .unknown: return "Unknown"
		}
	}
}

public struct DeckSchedule: Codable, Hashable, Identifiable, Sendable {
	public let id: String
	public let title: String
	/// Five cron fields, read in the deck machine's local time.
	public let cron: String
	public let prompt: String
	public let enabled: Bool
	/// Set when every run sends into this one session, so its context carries
	/// from run to run. Mutually exclusive with `cwd`.
	public let sessionId: String?
	/// Set when every run starts a fresh session in this directory.
	public let cwd: String?
	public let agent: AutomationAgent?
	public let createdAt: Double
	public let nextRunAt: Double?
	public let lastRunAt: Double?
	public let lastOutcome: ScheduleOutcome?
	/// Why the last run was skipped or failed.
	public let lastNote: String?
	public let lastSessionId: String?
	public let runs: Int
	/// The target session's title. Absent when that session has gone, which is
	/// the reason a schedule stopped.
	public let sessionTitle: String?
	/// The registered project behind `cwd`, when there is one.
	public let projectName: String?

	/// Whether each run reuses one session rather than starting a fresh one.
	public var isOngoing: Bool { sessionId != nil }

	/// A schedule pointing at a session deck can no longer find. It will not run
	/// again until it is pointed somewhere else.
	public var targetMissing: Bool { sessionId != nil && sessionTitle == nil }

	/// What this runs against, in a few words.
	public var targetLabel: String {
		if sessionId != nil { return sessionTitle ?? "session no longer exists" }
		return projectName ?? (cwd.map { ($0 as NSString).lastPathComponent } ?? "")
	}

	public var nextRun: Date? { nextRunAt.map { Date(timeIntervalSince1970: $0 / 1000) } }
	public var lastRun: Date? { lastRunAt.map { Date(timeIntervalSince1970: $0 / 1000) } }
}

/// What deck says a cron expression would do, from GET
/// /api/agent/schedules/preview. `problem` and `next` are separate answers: an
/// expression can read perfectly well and still never happen (30 February), and
/// that is an empty `next` with no problem to report.
public struct SchedulePreview: Codable, Hashable, Sendable {
	public let cron: String
	public let problem: String?
	public let next: [Double]

	public var dates: [Date] { next.map { Date(timeIntervalSince1970: $0 / 1000) } }

	public static let empty = SchedulePreview(cron: "", problem: nil, next: [])
}

/// The fields a schedule is created or edited with. Exactly one target: `cwd`
/// for a fresh session per run, `sessionId` to send into one that exists.
public struct ScheduleDraft: Hashable, Sendable {
	public var title: String
	public var cron: String
	public var prompt: String
	public var sessionId: String?
	public var cwd: String?
	public var agent: AutomationAgent

	public init(
		title: String = "",
		cron: String = "0 9 * * *",
		prompt: String = "",
		sessionId: String? = nil,
		cwd: String? = nil,
		agent: AutomationAgent = AutomationAgent()
	) {
		self.title = title
		self.cron = cron
		self.prompt = prompt
		self.sessionId = sessionId
		self.cwd = cwd
		self.agent = agent
	}

	public init(editing schedule: DeckSchedule) {
		self.init(
			title: schedule.title,
			cron: schedule.cron,
			prompt: schedule.prompt,
			sessionId: schedule.sessionId,
			cwd: schedule.cwd,
			agent: schedule.agent ?? AutomationAgent())
	}

	/// Enough filled in to save. deck validates properly; this only decides
	/// whether the button is tappable.
	public var isComplete: Bool {
		!prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
			&& !cron.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
			&& (sessionId != nil || cwd != nil)
	}

	/// The request body. Both halves of the target are always sent, the empty
	/// one blank, so moving an existing schedule from one shape to the other
	/// clears what it used to point at.
	public var json: [String: Any] {
		[
			"title": title.trimmingCharacters(in: .whitespacesAndNewlines),
			"cron": cron.trimmingCharacters(in: .whitespacesAndNewlines),
			"prompt": prompt,
			"sessionId": sessionId ?? "",
			"cwd": cwd ?? "",
			"agent": agent.json
		]
	}
}

/// The handful of shapes offered before anyone has to type cron. Matches the
/// web form's list, so the two apps offer the same starting points.
public struct CronPreset: Hashable, Sendable {
	public let label: String
	public let cron: String

	public static let all: [CronPreset] = [
		CronPreset(label: "Every 15 minutes", cron: "*/15 * * * *"),
		CronPreset(label: "Hourly, on the hour", cron: "0 * * * *"),
		CronPreset(label: "Every weekday at 9am", cron: "0 9 * * mon-fri"),
		CronPreset(label: "Every weekday at 6pm", cron: "0 18 * * mon-fri"),
		CronPreset(label: "Daily at 8am", cron: "0 8 * * *"),
		CronPreset(label: "Daily at midnight", cron: "0 0 * * *"),
		CronPreset(label: "Mondays at 9am", cron: "0 9 * * mon"),
		CronPreset(label: "First of the month at 9am", cron: "0 9 1 * *")
	]
}
