import AppIntents
import DeckKit

/// Registration point: app targets include this via AppIntentsPackage.
public struct DeckIntentsPackage: AppIntentsPackage {}

/// Siri starts claude sessions; other kinds are a phone-side choice.
let intentKind = "claude"

// MARK: - What needs my attention

public struct CheckAttentionIntent: AppIntent {
	public static let title: LocalizedStringResource = "Check What Needs Attention"
	public static let description = IntentDescription(
		"Lists deck sessions that are blocked waiting for your answer.")

	public init() {}

	public func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<String> {
		let client = try intentClient()
		async let asksTask = client.asks()
		async let sessionsTask = client.sessions()
		let (asks, sessions) = try await (asksTask, sessionsTask)
		let titles = Dictionary(uniqueKeysWithValues: sessions.map {
			($0.id, $0.title ?? $0.cwd.map { ($0 as NSString).lastPathComponent } ?? $0.id)
		})

		if asks.isEmpty {
			let running = sessions.filter { $0.status == .running }.count
			let summary = running > 0
				? "Nothing needs you. \(running) session\(running == 1 ? " is" : "s are") still running."
				: "Nothing needs you, and nothing is running."
			return .result(value: summary, dialog: IntentDialog(stringLiteral: summary))
		}

		let lines = asks.map { ask in
			// A blocked run's question carries the run's title as its header.
			let title = ask.runId != nil ? ask.questions.first?.header ?? "A workflow run" : titles[ask.sessionId] ?? ask.sessionId
			let question = ask.questions.first?.question ?? "a question"
			return "\(title) asks: \(question)"
		}
		let summary = "\(asks.count) session\(asks.count == 1 ? " needs" : "s need") you. "
			+ lines.joined(separator: " ")
		return .result(value: summary, dialog: IntentDialog(stringLiteral: summary))
	}
}

// MARK: - What sessions exist

/// The most basic ask, and the one Siri had no answer for: "show me my deck
/// sessions". Without it Siri says it cannot search sessions and suggests
/// opening the app, because App Shortcuts match registered phrases and none of
/// them covered listing.
public struct ListSessionsIntent: AppIntent {
	public static let title: LocalizedStringResource = "List Sessions"
	public static let description = IntentDescription(
		"Lists your deck sessions, newest first, with what each one is doing.")

	/// Narrows to sessions whose title contains this, so "show me the auth
	/// session in deck" gets one answer rather than forty.
	@Parameter(title: "Matching")
	public var matching: String?

	/// Siri reads a summary; the entities let Shortcuts pass them on.
	public init() {}

	public static var parameterSummary: some ParameterSummary {
		Summary("List deck sessions matching \(\.$matching)")
	}

	public func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<[SessionEntity]> {
		let sessions = try await intentClient().sessions()
			.sorted { ($0.lastActiveAt ?? 0) > ($1.lastActiveAt ?? 0) }

		let needle = (matching ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
		let hits = needle.isEmpty
			? sessions
			: sessions.filter { ($0.title ?? "").localizedCaseInsensitiveContains(needle) }

		guard !hits.isEmpty else {
			let summary = needle.isEmpty
				? "You have no sessions."
				: "No session matches \(needle)."
			return .result(value: [], dialog: IntentDialog(stringLiteral: summary))
		}

		let entities = hits.map(SessionEntity.init)
		let waiting = hits.filter { $0.awaitingInput == true }.count
		let running = hits.filter { $0.status == .running }.count

		// Spoken, so a count and the few that matter, not forty titles.
		var summary = "\(hits.count) session\(hits.count == 1 ? "" : "s")"
		if running > 0 { summary += ", \(running) running" }
		if waiting > 0 { summary += ", \(waiting) waiting on you" }
		summary += ". "
		summary += entities.prefix(5).map(\.title).joined(separator: ", ")
		if entities.count > 5 { summary += ", and \(entities.count - 5) more" }
		summary += "."

		return .result(value: entities, dialog: IntentDialog(stringLiteral: summary))
	}
}

// MARK: - Start work on an issue

public struct StartWorkIntent: AppIntent {
	public static let title: LocalizedStringResource = "Start Work on an Issue"
	public static let description = IntentDescription(
		"Spawns a deck coding session that starts working on an open issue.")

	@Parameter(title: "Issue")
	public var issue: IssueEntity

	@Parameter(title: "Extra instructions")
	public var instructions: String?

	public init() {}

	public static var parameterSummary: some ParameterSummary {
		Summary("Start work on \(\.$issue)") {
			\.$instructions
		}
	}

	public func perform() async throws -> some IntentResult & ProvidesDialog {
		let client = try intentClient()
		let defaults = await intentStartDefaults(
			client: client, kind: intentKind, projectPath: issue.projectPath)
		_ = try await client.createWorkSession(
			cwd: issue.projectPath,
			prompt: instructions ?? defaults.firstPrompt ?? FallbackPrompt.work,
			kind: intentKind,
			title: issue.issueId,
			model: defaults.modelId,
			provider: defaults.model.provider,
			effort: defaults.effort,
			permissionMode: defaults.permissionMode,
			worktree: .newBranch(named: issue.issueId, base: defaults.base),
			issue: issue.deckIssue,
			idempotencyKey: UUID().uuidString)
		return .result(dialog: "Started work on \(issue.shortId) in \(issue.projectName).")
	}
}

// MARK: - Start a session from a spoken instruction

/// Starting work with nothing but words. The issue and PR intents cover work
/// that already has a ticket; this is the "just do this thing" case, which was
/// the operator's most-used path and had no intent behind it.
public struct StartSessionIntent: AppIntent {
	public static let title: LocalizedStringResource = "Start a deck Session"
	public static let description = IntentDescription(
		"Starts a deck coding session in a project, working on whatever you describe.")

	@Parameter(title: "Project")
	public var project: ProjectEntity

	@Parameter(title: "What to do", requestValueDialog: "What should it work on?")
	public var task: String

	public init() {}

	public static var parameterSummary: some ParameterSummary {
		Summary("Start \(\.$task) in \(\.$project)")
	}

	public func perform() async throws -> some IntentResult & ProvidesDialog {
		let client = try intentClient()
		let defaults = await intentStartDefaults(client: client, kind: intentKind, projectPath: project.id)
        // The branch is named from the task, so a spoken session still lands
        // somewhere recognisable in the worktree list.
		let branch = StartSessionIntent.branchName(from: task)
		_ = try await client.createWorkSession(
			cwd: project.id,
			prompt: task,
			kind: intentKind,
			title: StartSessionIntent.title(from: task),
			model: defaults.modelId,
			provider: defaults.model.provider,
			effort: defaults.effort,
			permissionMode: defaults.permissionMode,
			worktree: .newBranch(named: branch, base: defaults.base),
			idempotencyKey: UUID().uuidString)
		return .result(dialog: "Started it in \(project.name).")
	}

	/// A few words for the session list, from a whole spoken instruction.
	static func title(from task: String) -> String {
		let words = task.split(whereSeparator: \.isWhitespace).prefix(6).joined(separator: " ")
		return words.isEmpty ? "New session" : words
	}

	/// A valid git ref: lowercase words joined by dashes, nothing else.
	static func branchName(from task: String) -> String {
		let slug = task.lowercased()
			.map { $0.isLetter || $0.isNumber ? $0 : "-" }
			.reduce(into: "") { result, character in
				if character == "-", result.last == "-" { return }
				result.append(character)
			}
			.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
			.split(separator: "-").prefix(5).joined(separator: "-")
		return slug.isEmpty ? "deck-session" : slug
	}
}

// MARK: - Start a PR review

public struct StartReviewIntent: AppIntent {
	public static let title: LocalizedStringResource = "Start a PR Review"
	public static let description = IntentDescription(
		"Spawns a deck session that checks out and reviews an open pull request.")

	@Parameter(title: "Pull request")
	public var pullRequest: PREntity

	public init() {}

	public static var parameterSummary: some ParameterSummary {
		Summary("Review \(\.$pullRequest)")
	}

	public func perform() async throws -> some IntentResult & ProvidesDialog {
		let client = try intentClient()
		let defaults = await intentStartDefaults(
			client: client, kind: intentKind, review: true, projectPath: pullRequest.projectPath)
		_ = try await client.createReviewSession(
			cwd: pullRequest.projectPath,
			pr: pullRequest.deckPR,
			prompt: defaults.firstPrompt ?? FallbackPrompt.review,
			kind: intentKind,
			model: defaults.modelId,
			provider: defaults.model.provider,
			effort: defaults.effort,
			permissionMode: defaults.permissionMode,
			idempotencyKey: UUID().uuidString)
		return .result(dialog: "Started reviewing \(pullRequest.repo) #\(pullRequest.number).")
	}
}

// MARK: - Answer the pending question

public struct AnswerIntent: AppIntent {
	public static let title: LocalizedStringResource = "Answer deck"
	public static let description = IntentDescription(
		"Answers the question a deck session is blocked on. With no session given, answers the oldest pending question.")

	@Parameter(title: "Session")
	public var session: SessionEntity?

	@Parameter(title: "Answer")
	public var answer: String

	public init() {}

	public static var parameterSummary: some ParameterSummary {
		Summary("Answer \(\.$answer)") {
			\.$session
		}
	}

	public func perform() async throws -> some IntentResult & ProvidesDialog {
		let client = try intentClient()
		let asks = try await client.asks()
		let target: DeckAsk
		if let session {
			guard let match = asks.first(where: { $0.sessionId == session.id }) else {
				throw DeckIntentError.nothingPending
			}
			target = match
		} else {
			guard let oldest = asks.first else { throw DeckIntentError.nothingPending }
			target = oldest
		}
		if let runId = target.runId {
			try await client.runAction(id: runId, .answer, text: answer)
			return .result(dialog: "Answered. The run is going again.")
		}
		let response = try await client.answer(
			sessionId: target.sessionId, text: answer, askId: target.askId)
		guard response.ok else { throw DeckIntentError.nothingPending }
		return .result(dialog: "Answered. The session is running again.")
	}
}

// MARK: - Send a prompt

public struct SendPromptIntent: AppIntent {
	public static let title: LocalizedStringResource = "Send a Prompt to a Session"
	public static let description = IntentDescription("Sends a prompt to a deck session.")

	@Parameter(title: "Session")
	public var session: SessionEntity

	@Parameter(title: "Prompt")
	public var prompt: String

	public init() {}

	public static var parameterSummary: some ParameterSummary {
		Summary("Send \(\.$prompt) to \(\.$session)")
	}

	public func perform() async throws -> some IntentResult & ProvidesDialog {
		let client = try intentClient()
		_ = try await client.send(sessionId: session.id, text: prompt)
		return .result(dialog: "Sent to \(session.title).")
	}
}

// MARK: - Session status

public struct SessionStatusIntent: AppIntent {
	public static let title: LocalizedStringResource = "Get Session Status"
	public static let description = IntentDescription(
		"Reads back a deck session's status and its latest reply.")

	@Parameter(title: "Session")
	public var session: SessionEntity?

	public init() {}

	public static var parameterSummary: some ParameterSummary {
		Summary("Status of \(\.$session)")
	}

	public func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<String> {
		let client = try intentClient()
		let id: String
		if let session {
			id = session.id
		} else {
			let sessions = try await client.sessions()
			guard let latest = sessions.max(by: { ($0.lastActiveAt ?? 0) < ($1.lastActiveAt ?? 0) }) else {
				throw DeckIntentError.notFound
			}
			id = latest.id
		}
		let detail = try await client.session(id: id)
		let name = detail.title ?? id
		var summary = "\(name) is \(detail.status.rawValue)."
		if detail.awaitingInput == true { summary = "\(name) is waiting on your answer." }
		if let result = detail.lastResult, !result.isEmpty {
			summary += " Last reply: \(String(result.prefix(280)))"
		}
		return .result(value: summary, dialog: IntentDialog(stringLiteral: summary))
	}
}

// MARK: - Stop a session

public struct StopSessionIntent: AppIntent {
	public static let title: LocalizedStringResource = "Stop a Session"
	public static let description = IntentDescription("Interrupts a deck session's current turn.")

	@Parameter(title: "Session")
	public var session: SessionEntity

	public init() {}

	public static var parameterSummary: some ParameterSummary {
		Summary("Stop \(\.$session)")
	}

	public func perform() async throws -> some IntentResult & ProvidesDialog {
		let client = try intentClient()
		_ = try await client.stop(sessionId: session.id)
		return .result(dialog: "Stopped \(session.title).")
	}
}
