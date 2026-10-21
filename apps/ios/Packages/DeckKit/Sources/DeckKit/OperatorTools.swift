#if canImport(FoundationModels) && !os(watchOS)
import Foundation
import FoundationModels

// deck's operator tools, for Apple's on-device model. These are the same seven
// the server operator had, and they call the same agent API endpoints; what
// changed is where the model deciding between them runs. Each is Sendable and
// holds the client it talks through.
//
// A tool returns prose, not JSON: the model reads the result as text, and
// "Auth token refresh is running" costs fewer tokens and confuses it less than
// a nested object.
//
// Every result is bounded, to whatever the model reading it can hold (see
// OperatorLimits). On Apple's on-device model the whole context is 4,096
// tokens, so one unbounded tool result ends the turn with "Provided 4,099
// tokens, but the maximum allowed is 4,096" and nothing said; a session's
// latest reply is routinely longer than that entire window. A downloaded model
// has room for the reply itself, and is given it.

extension String {
	/// Cut to the model's limit, saying so, since a silent truncation reads to
	/// the model as the end of the text.
	func boundedForTool(_ limits: OperatorLimits) -> String {
		count <= limits.resultCharacters
			? self
			: String(prefix(limits.resultCharacters)) + "… (cut short; ask for more if you need it)"
	}
}

/// Run a tool body, turning a failure into something the model can read.
///
/// A thrown error ends the whole turn: the model never learns what went wrong
/// and cannot try again, and the user just sees the turn die. A small model
/// guesses session ids from a vague question, so "no such session" has to come
/// back as a sentence telling it what to do instead.
@available(iOS 26.0, macOS 26.0, visionOS 26.0, *)
func deckToolResult(_ what: String, _ body: () async throws -> String) async -> String {
	do {
		return try await body()
	} catch let DeckError.http(status, message) {
		if status == 404 {
			return "No session with that id. Call list_sessions and use an id from it."
		}
		if status == 409 {
			return "That session is busy with a turn right now."
		}
		return "deck could not \(what): \(message ?? "error \(status)")."
	} catch {
		return "deck could not \(what): \(error.localizedDescription)"
	}
}

@available(iOS 26.0, macOS 26.0, visionOS 26.0, *)
struct ListSessionsTool: Tool {
	let name = "list_sessions"
	let description = "The current sessions with status, project, and any question waiting for an answer."
	let client: DeckClient
	let limits: OperatorLimits

	@Generable struct Arguments {}

	func call(arguments: Arguments) async -> String {
		await deckToolResult("list the sessions") {
			// Hidden sessions are left out: hiding one says you do not want to
			// hear about it, and no context window is worth spending on sessions
			// you have already set aside.
			let sessions = try await client.sessions().filter { $0.hidden != true }
			let asks = (try? await client.asks()) ?? []
			if sessions.isEmpty { return "There are no sessions." }

			// Newest first, then capped. Seventy sessions at ~80 characters each
			// spends a third of Apple's whole window before anything is said, and
			// the ones just touched are the ones the user means. The project path
			// is dropped for the same reason: the title carries the meaning.
			let recent = sessions
				.sorted { ($0.lastActiveAt ?? 0) > ($1.lastActiveAt ?? 0) }
				.prefix(limits.sessionRows)

			let lines = recent.map { session -> String in
				var line = "id=\(session.id) title=\(session.title ?? session.id) status=\(session.status.rawValue)"
				if let ask = asks.first(where: { $0.sessionId == session.id }) {
					line += " waiting-on=\"\(ask.questions.first?.question ?? "a question")\""
				}
				return line
			}
			let omitted = sessions.count - recent.count
			return lines.joined(separator: "\n")
				+ (omitted > 0 ? "\n(\(omitted) older sessions not listed)" : "")
		}
	}
}

@available(iOS 26.0, macOS 26.0, visionOS 26.0, *)
struct LatestReplyTool: Tool {
	let name = "latest_reply"
	let description = "A session's newest reply in full. Summarise it unless the user asked to hear all of it."
	let client: DeckClient
	let limits: OperatorLimits

	@Generable struct Arguments {
		@Guide(description: "The session id from the sessions list")
		var sessionId: String
	}

	func call(arguments: Arguments) async -> String {
		await deckToolResult("read that session") {
		let detail = try await client.session(id: arguments.sessionId)
		guard let reply = detail.lastResult, !reply.isEmpty else { return "That session has not replied yet." }
		return reply.boundedForTool(limits)
		}
	}
}

@available(iOS 26.0, macOS 26.0, visionOS 26.0, *)
struct SendMessageTool: Tool {
	let name = "send_message"
	let description = "Send an instruction to a session's agent. A skill runs as '/skill-name arguments'."
	let client: DeckClient
	let limits: OperatorLimits

	@Generable struct Arguments {
		@Guide(description: "The session id from the sessions list")
		var sessionId: String
		@Guide(description: "What to tell the agent")
		var text: String
	}

	func call(arguments: Arguments) async -> String {
		await deckToolResult("send that message") {
		// `skills: true` lets deck turn "run dev-workflow on ENG-1" into the
		// slash command that actually runs the skill, against the skills
		// installed on that machine (see send-agent-message.ts).
		try await client.sendOperatorMessage(sessionId: arguments.sessionId, text: arguments.text)
		return "Sent."
		}
	}
}

@available(iOS 26.0, macOS 26.0, visionOS 26.0, *)
struct AnswerAskTool: Tool {
	let name = "answer_ask"
	let description = "Answer the question a session is waiting on, with an option's label or free text."
	let client: DeckClient
	let limits: OperatorLimits

	@Generable struct Arguments {
		@Guide(description: "The session id from the sessions list")
		var sessionId: String
		@Guide(description: "The option's label, or free text")
		var answer: String
	}

	func call(arguments: Arguments) async -> String {
		await deckToolResult("answer that question") {
		let asks = try await client.asks()
		guard let ask = asks.first(where: { $0.sessionId == arguments.sessionId }) else {
			return "That session is not waiting on a question."
		}
		// Match a spoken answer to an option the way the server did: an option
		// whose label was said, or its number, else send the words as they came.
		let options = ask.questions.first?.options?.map(\.label) ?? []
		let picked = OperatorPhrasing.pickOption(arguments.answer, options: options) ?? arguments.answer
		_ = try await client.answer(sessionId: arguments.sessionId, text: picked, askId: ask.askId)
		return "Answered with \(picked)."
		}
	}
}

@available(iOS 26.0, macOS 26.0, visionOS 26.0, *)
struct StopSessionTool: Tool {
	let name = "stop_session"
	let description = "Interrupt a session's current turn."
	let client: DeckClient
	let limits: OperatorLimits

	@Generable struct Arguments {
		@Guide(description: "The session id from the sessions list")
		var sessionId: String
	}

	func call(arguments: Arguments) async -> String {
		await deckToolResult("stop that turn") {
		_ = try await client.stop(sessionId: arguments.sessionId)
		return "Stopped."
		}
	}
}

@available(iOS 26.0, macOS 26.0, visionOS 26.0, *)
struct StartSessionTool: Tool {
	let name = "start_session"
	let description = """
		Start a new claude session in a project on its own branch. Creates a worktree, so first tell \
		the user the project and prompt and wait for a yes; only then call with confirmed=true. \
		A skill runs as '/skill-name arguments' in the prompt.
		"""
	let client: DeckClient
	let limits: OperatorLimits

	@Generable struct Arguments {
		@Guide(description: "A registered project name")
		var project: String
		@Guide(description: "The first message to the agent")
		var prompt: String
		@Guide(description: "A short title, a few words")
		var title: String?
		@Guide(description: "True only after the user agreed to this exact session")
		var confirmed: Bool
	}

	func call(arguments: Arguments) async -> String {
		await deckToolResult("start that session") {
		// The model is told to ask first, but a small model forgets, and this
		// one creates a git worktree. The refusal is the guard, not the prompt.
		guard arguments.confirmed else {
			return "Not started: say what you would start and wait for the user to agree, then call again with confirmed=true."
		}
		let projects = try await client.projects()
		let match = projects.first { $0.name.caseInsensitiveCompare(arguments.project) == .orderedSame }
			?? projects.first { $0.name.localizedCaseInsensitiveContains(arguments.project) }
		guard let project = match else {
			return "No project called \(arguments.project). Known projects: \(projects.map(\.name).joined(separator: ", "))."
		}
		let session = try await client.createWorkSession(
			cwd: project.path,
			prompt: arguments.prompt,
			kind: "claude",
			title: arguments.title)
		return "Started \(arguments.title ?? "the session") in \(project.name) (id=\(session.id))."
		}
	}
}

/// Skills are looked up, not listed up front. Naming all 142 of this machine's
/// skills in the instructions cost 12.4 seconds a turn against 1.4 without
/// them: the server operator got away with it because its endpoint cached the
/// prompt prefix, and Apple's on-device model re-reads the instructions every
/// turn. A tool call costs that only when the conversation is about skills.
@available(iOS 26.0, macOS 26.0, visionOS 26.0, *)
struct ListSkillsTool: Tool {
	let name = "list_skills"
	let description = "The skills the user can run, by name. Call this when they mention a skill or ask what can be run."
	let client: DeckClient
	let limits: OperatorLimits

	@Generable struct Arguments {
		@Guide(description: "Words to look for in a skill's name or description; empty lists every skill's name")
		var matching: String?
	}

	func call(arguments: Arguments) async -> String {
		await deckToolResult("list the skills") {
		let skills = try await client.skills()
		if skills.isEmpty { return "No skills are installed." }
		let needle = (arguments.matching ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
		guard !needle.isEmpty else {
			// Names only: a hundred descriptions is the cost this tool exists to avoid.
			return "Skills: " + skills.map(\.name).joined(separator: ", ")
		}
		let hits = skills.filter {
			$0.name.lowercased().contains(needle) || $0.description.lowercased().contains(needle)
		}
		guard !hits.isEmpty else {
			return "No skill matches \(needle). All of them: " + skills.map(\.name).joined(separator: ", ")
		}
		return hits.prefix(12)
			.map { "\($0.name) (\($0.scope)): \($0.description.split(separator: ".").first.map(String.init) ?? "")" }
			.joined(separator: "\n")
		}
	}
}

@available(iOS 26.0, macOS 26.0, visionOS 26.0, *)
struct SkillDetailsTool: Tool {
	let name = "skill_details"
	let description = "What a skill does, from its SKILL.md, when the user asks about it."
	let client: DeckClient
	let limits: OperatorLimits

	@Generable struct Arguments {
		@Guide(description: "The skill's name, as listed in the instructions")
		var name: String
	}

	func call(arguments: Arguments) async -> String {
		await deckToolResult("read that skill") {
		guard let body = try await client.skillBody(name: arguments.name) else {
			return "No skill named \(arguments.name)."
		}
		return body.boundedForTool(limits)
		}
	}
}

@available(iOS 26.0, macOS 26.0, visionOS 26.0, *)
extension DeckClient {
	/// Every deck tool, bound to this client.
	/// The operator's tools, bounded for whichever model is about to read them.
	func operatorTools(limits: OperatorLimits) -> [any Tool] {
		[
			ListSessionsTool(client: self, limits: limits),
			LatestReplyTool(client: self, limits: limits),
			SendMessageTool(client: self, limits: limits),
			AnswerAskTool(client: self, limits: limits),
			StopSessionTool(client: self, limits: limits),
			StartSessionTool(client: self, limits: limits),
			ListSkillsTool(client: self, limits: limits),
			SkillDetailsTool(client: self, limits: limits)
		]
	}
}
#endif
