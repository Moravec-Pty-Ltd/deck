import Foundation

// Shapes mirror deck's agent API contract (GET /llms.txt, version 2.0.0).
// Everything non-essential is optional so contract additions never break decoding.

public struct DeckProject: Codable, Hashable, Identifiable, Sendable {
	public var id: String { path }
	public let path: String
	public let name: String
	public let group: String?
	/// Set only on a project the user has hidden, which takes its sessions out
	/// of the list with it. Absent on older deck servers.
	public var hidden: Bool?
}

public struct KindModel: Codable, Hashable, Sendable {
	public let provider: String?
	public let model: String
	/// Set by the server on a premium model worth a confirm before using it.
	public let expensive: Bool?
}

public struct AgentKind: Codable, Hashable, Identifiable, Sendable {
	public var id: String { kind }
	public let kind: String
	public let available: Bool
	public let models: [KindModel]?
}

public struct DeckIssue: Codable, Hashable, Identifiable, Sendable {
	public var id: String { "\(sourceId ?? source)/\(issueId)" }
	public let source: String
	public let sourceId: String?
	public let issueId: String
	public let title: String?
	public let url: String?

	enum CodingKeys: String, CodingKey {
		case source, sourceId
		case issueId = "id"
		case title
		case url
	}

	public init(source: String, sourceId: String? = nil, issueId: String, title: String? = nil, url: String? = nil) {
		self.source = source
		self.sourceId = sourceId
		self.issueId = issueId
		self.title = title
		self.url = url
	}

	/// The id as a person reads it: a GitHub `owner/repo#42` shortens to `#42`,
	/// which is all that fits on a watch row. Display only; `issueId` stays whole
	/// for API payloads, ids and idempotency keys. Linear and ClickUp ids carry
	/// no repo prefix, so they pass through.
	public var shortId: String {
		guard source == "github" else { return issueId }
		guard let hash = issueId.lastIndex(of: "#") else { return issueId }
		let number = issueId[issueId.index(after: hash)...]
		guard !number.isEmpty, number.allSatisfy(\.isNumber) else { return issueId }
		return "#\(number)"
	}

	/// The `owner/repo` a GitHub id names, for surfaces with room to keep it
	/// beside the short form. Nil when the id carries no repo.
	public var repo: String? {
		guard source == "github", shortId != issueId else { return nil }
		let prefix = issueId.prefix { $0 != "#" }
		return prefix.isEmpty ? nil : String(prefix)
	}
}

public struct SourceError: Codable, Hashable, Sendable {
	public let sourceId: String?
	public let message: String
}

public struct IssuesResponse: Codable, Sendable {
	public let issues: [DeckIssue]
	public let errors: [SourceError]?
}

public struct DeckPR: Codable, Hashable, Identifiable, Sendable {
	public var id: String { "\(repo)#\(number)" }
	public let repo: String
	public let number: Int
	public let title: String?
	public let url: String?
	public let headRefName: String?
	public let baseRefName: String?
	public let isDraft: Bool?
	public let author: String?

	public init(
		repo: String, number: Int, title: String? = nil, url: String? = nil,
		headRefName: String? = nil, baseRefName: String? = nil,
		isDraft: Bool? = nil, author: String? = nil
	) {
		self.repo = repo
		self.number = number
		self.title = title
		self.url = url
		self.headRefName = headRefName
		self.baseRefName = baseRefName
		self.isDraft = isDraft
		self.author = author
	}
}

public struct PRsResponse: Codable, Sendable {
	public let prs: [DeckPR]
	public let errors: [SourceError]?
}

public enum SessionStatus: String, Codable, Sendable {
	case running, idle, error, dead, unknown

	public init(from decoder: Decoder) throws {
		let raw = try decoder.singleValueContainer().decode(String.self)
		self = SessionStatus(rawValue: raw) ?? .unknown
	}
}

public struct SessionWorktree: Codable, Hashable, Sendable {
	public let repo: String?
	public let branch: String?
	public let createdBranch: Bool?
	public let base: String?
}

public struct SessionPR: Codable, Hashable, Sendable {
	public let repo: String?
	public let number: Int?
	public let url: String?
	public let state: String?
	public let reviewDecision: String?
	public let mergeable: String?
	public let approvals: Int?
	public let changesRequested: Int?
	/// PR author login. When it differs from the signed-in gh user the PR is one
	/// you are only reviewing, so merge should be hidden.
	public let author: String?
	public let title: String?
	/// `BLOCKED` when branch protection holds an otherwise mergeable PR.
	public let mergeStateStatus: String?

	/// Mirrors deck's merge gate: an open, mergeable PR of your own. An unknown
	/// author or login counts as yours, as the server's canMergePr does.
	public func canMerge(as me: String?) -> Bool {
		guard state?.lowercased() == "open", mergeable == "MERGEABLE" else { return false }
		guard let author, let me else { return true }
		return author == me
	}
}

public struct SessionCost: Codable, Hashable, Sendable {
	public let costUsd: Double?
	public let turns: Int?
	public let durationMs: Double?
	public let results: Int?
}

/// How full a session's context window is. Absent until a turn has reported
/// both figures, so `window` is never 0 on a value deck actually sent.
public struct SessionContext: Codable, Hashable, Sendable {
	public let used: Int
	public let window: Int

	/// 0 to 100, capped: a turn can overrun the window before it is compacted.
	public var percent: Int {
		guard window > 0 else { return 0 }
		return min(100, Int((Double(used) / Double(window) * 100).rounded()))
	}

	/// `703k`, `1.0M`. Thousands below a million: a window reads as "how much of
	/// my million", and `0.2M` reads worse than `248k`.
	public static func tokens(_ n: Int) -> String {
		if n >= 1_000_000 {
			// Round the tenth before formatting: `%.1f` rounds a half to even
			// (1.25M reads as "1.2M"), while the web's toFixed rounds it away
			// from zero, and the two clients must show the same number.
			return String(format: "%.1fM", (Double(n) / 100_000).rounded() / 10)
		}
		if n >= 1_000 { return "\(Int((Double(n) / 1000).rounded()))k" }
		return String(max(0, n))
	}

	/// `703k / 1.0M tokens`.
	public var summary: String {
		"\(Self.tokens(used)) / \(Self.tokens(window)) tokens"
	}
}

public struct SessionDigest: Codable, Hashable, Identifiable, Sendable {
	public let id: String
	public let url: String?
	public let kind: String?
	public var title: String?
	public let cwd: String?
	public var status: SessionStatus
	public var awaitingInput: Bool?
	public let createdAt: Double?
	public var lastActiveAt: Double?
	public let model: String?
	public var effort: String?
	public let worktree: SessionWorktree?
	public let issues: [DeckIssue]?
	public var pr: SessionPR?
	public var cost: SessionCost?
	public var context: SessionContext?
	/// Set only on a hidden session, whether it was hidden itself or its project
	/// was. deck answers that once so no client re-derives it.
	public var hidden: Bool?
	/// Its active watches, newest first; absent when none.
	public var watches: [Watch]?

	/// A review session: its worktree is parked on the captured PR's `pr/<n>`
	/// ref. Mirrors the web's isReviewSession in src/lib/pr.ts.
	public var isReviewSession: Bool {
		guard let number = pr?.number else { return false }
		return worktree?.branch == "pr/\(number)"
	}
}

public struct SessionDetail: Codable, Sendable {
	public let id: String
	public let url: String?
	public let kind: String?
	public let title: String?
	public let cwd: String?
	public let status: SessionStatus
	public let awaitingInput: Bool?
	public let model: String?
	public let effort: String?
	public let worktree: SessionWorktree?
	public let pr: SessionPR?
	public let cost: SessionCost?
	public let lastResult: String?
}

public struct TranscriptMessage: Codable, Hashable, Sendable {
	public let role: String
	public let text: String
}

public struct Transcript: Codable, Sendable {
	public let messages: [TranscriptMessage]
	public let lastResult: String?
	public let cost: SessionCost?
}

/// A contiguous slice of raw transcript events (GET /api/agent/sessions/{id}/history):
/// `events[k]` is absolute index `start + k`.
public struct TranscriptSlice: Decodable, Sendable {
	public let start: Int
	public let events: [JSONValue]
}

public struct AskOption: Codable, Hashable, Sendable {
	public let label: String
	public let description: String?

	public init(label: String, description: String? = nil) {
		self.label = label
		self.description = description
	}
}

public struct AskQuestion: Codable, Hashable, Sendable {
	public let question: String
	public let header: String?
	public let multiSelect: Bool?
	public let options: [AskOption]?

	public init(question: String, header: String? = nil, multiSelect: Bool? = nil, options: [AskOption]? = nil) {
		self.question = question
		self.header = header
		self.multiSelect = multiSelect
		self.options = options
	}
}

public struct DeckAsk: Codable, Hashable, Identifiable, Sendable {
	public var id: String { runId.map { "run-\($0)" } ?? "\(sessionId)-\(askId ?? String(askedAt ?? 0))" }
	/// For a blocked run, its latest phase session (deck forwards an answer
	/// posted there to the run), or the run id when it has no session yet.
	public let sessionId: String
	public let source: String?
	/// The ask's tool-call id, when deck matched it on the transcript. Sent back
	/// with the answer so the picks persist against the question.
	public let askId: String?
	/// Set when this is a blocked workflow run rather than a session's question.
	public let runId: String?
	public let askedAt: Double?
	public let questions: [AskQuestion]

	public init(sessionId: String, source: String? = nil, askId: String? = nil, runId: String? = nil, askedAt: Double? = nil, questions: [AskQuestion]) {
		self.sessionId = sessionId
		self.source = source
		self.askId = askId
		self.runId = runId
		self.askedAt = askedAt
		self.questions = questions
	}

	enum CodingKeys: String, CodingKey {
		case sessionId, source, askId, runId, askedAt, questions
	}

	// GET /api/agent/asks lists blocked runs beside the session asks, and a run
	// with no phase session yet has no sessionId. Without the fallback that one
	// entry fails the whole list.
	public init(from decoder: Decoder) throws {
		let c = try decoder.container(keyedBy: CodingKeys.self)
		runId = try c.decodeIfPresent(String.self, forKey: .runId)
		if let runId {
			sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId) ?? runId
		} else {
			sessionId = try c.decode(String.self, forKey: .sessionId)
		}
		source = try c.decodeIfPresent(String.self, forKey: .source)
		askId = try c.decodeIfPresent(String.self, forKey: .askId)
		askedAt = try c.decodeIfPresent(Double.self, forKey: .askedAt)
		questions = try c.decode([AskQuestion].self, forKey: .questions)
	}
}

/// One question's picked labels (plus any typed reply), as deck records them on
/// the transcript so every client shows the question answered the same way.
public struct StructuredAnswer: Codable, Hashable, Sendable {
	public let header: String
	public let labels: [String]

	public init(header: String, labels: [String]) {
		self.header = header
		self.labels = labels
	}
}

public struct CreateSessionResponse: Codable, Sendable {
	public let id: String
	public let url: String?
}

public struct MessageResponse: Codable, Sendable {
	public let ok: Bool
	public let status: String?
	public let seq: Int?
}

public struct AnswerResponse: Codable, Sendable {
	public let ok: Bool
	public let seq: Int?
	public let reason: String?
}

/// A rename's reply. `id` is where the session ended up: renaming an
/// unregistered tmux terminal renames the tmux session, so deck's derived id
/// moves with it.
public struct RenameResponse: Codable, Sendable {
	public let ok: Bool
	public let id: String
	public let title: String
}

/// A skill installed on the deck machine (`GET /api/agent/skills`).
public struct DeckSkill: Codable, Hashable, Identifiable, Sendable {
	public var id: String { "\(scope)/\(name)" }
	public let name: String
	public let description: String
	/// "global" for ~/.claude/skills, else the project the skill belongs to.
	public let scope: String
}

public enum SessionTitle {
	/// What deck's rename endpoint accepts (MAX_TITLE_LENGTH in its
	/// session-title module). Held to here so the field stops you before the
	/// round trip does.
	public static let maxLength = 80
}

public struct DeckEvent: Codable, Sendable {
	public let seq: Int
	public let sessionId: String?
	public let type: String
	public let at: Double?
	public let status: SessionStatus?
	public let awaitingInput: Bool?
	public let source: String?
	public let askId: String?
	public let questions: [AskQuestion]?
	public let subtype: String?
	public let cost: SessionCost?
	public let pr: SessionPR?
	public let session: SessionDigest?
	/// `session-hidden`: the session's effective hidden state. A project's hide
	/// names the `project` and its own `projectHidden` as well, which cannot be
	/// read off `hidden` because a session can stay hidden on its own after its
	/// project comes back.
	public let hidden: Bool?
	public let project: String?
	public let projectHidden: Bool?
	/// `run-updated`: which run changed, where it is now, and when. The digest
	/// itself is fetched separately.
	public let runId: String?
	public let phase: String?
	public let updatedAt: Double?
	/// `pairing`: a device asked for access (`state` pending, with its `code`)
	/// or the request was decided (approved or denied).
	/// `watches`: the session's full new list of active watches, empty when none are left.
	public let watches: [Watch]?
	public let pairingId: String?
	public let code: String?
	public let state: String?
}

public struct EventsResponse: Codable, Sendable {
	public let events: [DeckEvent]?
	public let snapshot: [SessionDigest]?
	public let gap: Bool?
	public let seq: Int
}

public struct APIErrorBody: Codable, Sendable {
	public let message: String
	/// Set on a create's 409 for a leftover branch (see WorktreeConflict).
	public let code: String?
	public let branch: String?
}

/// What deck does about a worktree branch an earlier session left behind:
/// `reuse` checks it out as it stands, `recreate` deletes it and branches
/// again from the base. Mirrors the web's src/lib/worktree-conflict.ts.
public enum WorktreeFix: String, CaseIterable, Sendable {
	case reuse
	case recreate

	public var label: String {
		self == .reuse ? "Use the existing branch" : "Delete it and start fresh"
	}

	public func detail(branch: String) -> String {
		self == .reuse
			? "Check \(branch) out as it stands, keeping any commits on it."
			: "Delete \(branch) and branch again from the base. Commits on it that are not pushed are lost."
	}
}

/// A create's 409 for a leftover worktree branch, answerable by retrying the
/// same body with `worktree.onExisting`.
public struct WorktreeConflict: Equatable, Sendable {
	public enum Code: String, Sendable {
		case branchExists = "branch-exists"
		case staleWorktree = "stale-worktree"
	}

	public let code: Code
	public let branch: String
	public let message: String

	public init(code: Code, branch: String, message: String) {
		self.code = code
		self.branch = branch
		self.message = message
	}

	/// Only a 409 whose code is one of ours: a 409 from elsewhere (a busy turn)
	/// must not be offered a fix that cannot help.
	init?(status: Int, body: APIErrorBody?) {
		guard status == 409, let body, let raw = body.code, let code = Code(rawValue: raw) else { return nil }
		self.init(code: code, branch: body.branch ?? "", message: body.message)
	}
}

/// A saved canned composer message. `text` may contain [tokens] that deck
/// expands at send time. Stored in one ordered list in deck; `projectId` (a
/// registered project's path) scopes it to that project's sessions, and nil
/// makes it global. An older deck never sends `projectId`, so every message
/// reads as global there.
public struct QuickMessage: Codable, Identifiable, Hashable, Sendable {
	public var id: String
	public var label: String?
	public var text: String
	public var projectId: String?

	public init(id: String = UUID().uuidString, label: String? = nil, text: String, projectId: String? = nil) {
		self.id = id
		self.label = label
		self.text = text
		self.projectId = projectId
	}

	/// What a session's picker offers: the project's messages first, then the
	/// global ones, each in stored order. Mirrors deck's `quickMessagesFor`.
	public static func offered(_ list: [QuickMessage], projectId: String?) -> [QuickMessage] {
		let own = projectId.map { id in list.filter { $0.projectId == id } } ?? []
		return own + list.filter { $0.projectId == nil }
	}

	public var displayLabel: String {
		if let label, !label.isEmpty { return label }
		return text.count > 48 ? String(text.prefix(47)) + "…" : text
	}
}

/// New-branch/worktree options for a work session.
public struct WorktreeOptions: Equatable, Sendable {
	public var branch: String?
	public var newBranch: Bool
	public var base: String?
	/// The answer to an earlier 409 for this branch; nil on a first attempt.
	public var onExisting: WorktreeFix?

	public init(branch: String? = nil, newBranch: Bool = true, base: String? = nil, onExisting: WorktreeFix? = nil) {
		self.branch = branch
		self.newBranch = newBranch
		self.base = base
		self.onExisting = onExisting
	}

	/// A fresh worktree on a new branch, named the way deck's web modal names it:
	/// after the session title (the issue ref, when started from an issue). Nil
	/// when there is no name, since deck reads a branchless worktree request as
	/// "no worktree at all".
	public static func newBranch(named name: String?, base: String? = nil) -> WorktreeOptions? {
		let branch = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
		guard !branch.isEmpty else { return nil }
		return WorktreeOptions(branch: branch, newBranch: true, base: base)
	}

	var json: [String: Any] {
		var dict: [String: Any] = ["newBranch": newBranch]
		if let branch, !branch.isEmpty { dict["branch"] = branch }
		if let base, !base.isEmpty { dict["base"] = base }
		if let onExisting { dict["onExisting"] = onExisting.rawValue }
		return dict
	}
}

/// Bracketed tokens deck expands into the first prompt at session-start time.
public enum DeckPlaceholders {
	public static let work = [
		"[title]", "[branch-name]", "[base-branch]", "[cwd]",
		"[issue_id]", "[issue_url]", "[issue_title]", "[issue_body]", "[issue_comments]"
	]
	public static let review = [
		"[pr_number]", "[pr_title]", "[pr_branch]", "[pr_base]", "[pr_url]", "[cwd]"
	]
}

/// Model ids the claude CLI enumerates (kinds endpoint returns an empty list
/// for claude, so these are the known defaults).
public enum DeckModels {
	public static let claude = ["fable", "opus", "sonnet", "haiku"]
	public static let defaultClaude = "opus"

	/// Models to offer for a kind: for claude, the built-in shortnames plus any
	/// locally-configured model profiles the server reports (those point a
	/// session at another backend and live only in the user's deck settings, so
	/// they never appear in either repo's source). Other kinds use whatever their
	/// CLI enumerates. Duplicates are dropped so a profile named after a
	/// shortname cannot list twice.
	public static func merge(kind: String, enumerated: [String]) -> [String] {
		guard kind == "claude" else { return enumerated }
		return claude + enumerated.filter { !claude.contains($0) }
	}
}

/// Claude reasoning-effort ("thinking") levels deck accepts.
public enum DeckEffort {
	public static let levels = ["low", "medium", "high", "xhigh", "max"]
}

/// A pasted or picked image to attach to a message (base64 data + media type).
public struct DeckImage: Identifiable, Hashable, Sendable {
	public let id: String
	public let mediaType: String
	public let data: String

	public init(id: String = UUID().uuidString, mediaType: String, data: String) {
		self.id = id
		self.mediaType = mediaType
		self.data = data
	}
}

public struct ModelChoice: Codable, Hashable, Sendable {
	public let provider: String?
	public let model: String

	public init(provider: String? = nil, model: String) {
		self.provider = provider
		self.model = model
	}
}

/// What one automation lane spawns with (GET/PATCH /api/agent/projects/config `automation`).
/// Every field optional: unset falls back to the project's remembered pick.
public struct AutomationAgent: Codable, Hashable, Sendable {
	public var kind: String?
	public var model: String?
	public var provider: String?
	public var effort: String?

	public init(kind: String? = nil, model: String? = nil, provider: String? = nil, effort: String? = nil) {
		self.kind = kind
		self.model = model
		self.provider = provider
		self.effort = effort
	}

	/// The stored form: an untouched claude lane collapses to an empty object,
	/// which the server reads as "clear it" (an omitted key would carry the
	/// previous pick, so "back to the default" would be unreachable).
	public var json: [String: Any] {
		var dict: [String: Any] = [:]
		let kind = self.kind ?? "claude"
		let model = self.model?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
		let provider = self.provider?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
		if kind == "claude", model.isEmpty, provider.isEmpty, (effort ?? "").isEmpty { return dict }
		dict["kind"] = kind
		if !model.isEmpty { dict["model"] = model }
		if kind == "pi", !provider.isEmpty { dict["provider"] = provider }
		if kind == "claude", let effort, !effort.isEmpty { dict["effort"] = effort }
		return dict
	}
}

/// Per-project feed automation: spawn a session for each new issue assigned to
/// you (`work`) or PR awaiting your review (`review`).
public struct ProjectAutomation: Codable, Hashable, Sendable {
	public var work: Bool?
	public var review: Bool?
	public var workAgent: AutomationAgent?
	public var reviewAgent: AutomationAgent?

	public init(work: Bool? = nil, review: Bool? = nil, workAgent: AutomationAgent? = nil, reviewAgent: AutomationAgent? = nil) {
		self.work = work
		self.review = review
		self.workAgent = workAgent
		self.reviewAgent = reviewAgent
	}

	public var json: [String: Any] {
		[
			"work": work ?? false,
			"review": review ?? false,
			"workAgent": (workAgent ?? AutomationAgent()).json,
			"reviewAgent": (reviewAgent ?? AutomationAgent()).json
		]
	}
}

/// A project's full stored record (GET /api/agent/projects/config), for what
/// the discovery list omits: the display name and automation config.
public struct ProjectDetail: Codable, Sendable {
	public let path: String
	public let name: String?
	public let group: String?
	/// The first prompt of a work session, before placeholders expand.
	public let template: String?
	/// The first prompt of a review session.
	public let reviewPrompt: String?
	public let hidden: Bool?
	public let automation: ProjectAutomation?
	public let dev: DevConfig?

	public init(
		path: String, name: String?, group: String?, template: String? = nil, reviewPrompt: String? = nil,
		hidden: Bool? = nil, automation: ProjectAutomation?, dev: DevConfig? = nil
	) {
		self.path = path
		self.name = name
		self.group = group
		self.template = template
		self.reviewPrompt = reviewPrompt
		self.hidden = hidden
		self.automation = automation
		self.dev = dev
	}
}

/// What one agent kind starts with by default in a project, as the server
/// resolves it (GET /api/agent/defaults): the remembered model, pi's provider,
/// claude's effort and permission mode.
public struct KindStartDefaults: Codable, Hashable, Sendable {
	public let model: String
	public let provider: String?
	public let effort: String?
	public let permissionMode: String?

	public init(model: String, provider: String? = nil, effort: String? = nil, permissionMode: String? = nil) {
		self.model = model
		self.provider = provider
		self.effort = effort
		self.permissionMode = permissionMode
	}
}

public struct StartPrompts: Codable, Hashable, Sendable {
	public let work: String?
	public let review: String?

	public init(work: String? = nil, review: String? = nil) {
		self.work = work
		self.review = review
	}
}

/// Everything a new session in a project starts with when nothing is picked:
/// the same defaults the web modal preselects, published by the server so no
/// client keeps its own copy of the rules.
public struct ProjectStartDefaults: Codable, Hashable, Sendable {
	public let path: String
	public let base: String?
	public let prompts: StartPrompts
	public let kinds: [String: KindStartDefaults]
	/// The server's expensive-model list (see `ExpensiveModels`). Absent on a
	/// deck that does not advertise `expensive-models`.
	public let expensiveModels: [String]?

	public init(
		path: String, base: String? = nil, prompts: StartPrompts = StartPrompts(),
		kinds: [String: KindStartDefaults] = [:], expensiveModels: [String]? = nil
	) {
		self.path = path
		self.base = base
		self.prompts = prompts
		self.kinds = kinds
		self.expensiveModels = expensiveModels
	}
}

/// The first prompt a surface with no keyboard (watch, Siri) falls back to when
/// the project configures no template. deck dispatches a turn only when a prompt
/// is present, so starting without one leaves the session idle forever.
public enum FallbackPrompt {
	public static let work = """
		Work on [issue_id]: [issue_title]

		[issue_url]

		[issue_body]
		"""
	public static let review = """
		Review pull request [pr_number]: [pr_title]

		[pr_url]

		Report what you find.
		"""
}

/// The server's start defaults for one kind and mode, in the shape the start
/// surfaces consume. When the server's defaults haven't been fetched the
/// values are nil/empty, which leaves each choice to the server's create path.
public struct StartDefaults: Sendable {
	public let model: ModelChoice
	public let effort: String?
	public let base: String?
	/// The prompt to send: the project's configured template for the mode, or
	/// the keyboardless fallback when it configures none. Nil when the defaults
	/// haven't been fetched, which leaves the choice to the server.
	public let firstPrompt: String?
	public let permissionMode: String?

	/// The model id to send, or nil to let the CLI pick.
	public var modelId: String? { model.model.isEmpty ? nil : model.model }

	public init(model: ModelChoice, effort: String? = nil, base: String? = nil, firstPrompt: String? = nil, permissionMode: String? = nil) {
		self.model = model
		self.effort = effort
		self.base = base
		self.firstPrompt = firstPrompt
		self.permissionMode = permissionMode
	}

	public static func resolve(kind: String, review: Bool = false, project: ProjectStartDefaults?) -> StartDefaults {
		let kindDefaults = project?.kinds[kind]
		return StartDefaults(
			model: ModelChoice(provider: kindDefaults?.provider, model: kindDefaults?.model ?? ""),
			effort: kindDefaults?.effort,
			base: project?.base,
			firstPrompt: firstPrompt(review: review, project: project),
			permissionMode: kindDefaults?.permissionMode)
	}

	private static func firstPrompt(review: Bool, project: ProjectStartDefaults?) -> String? {
		guard let project else { return nil }
		let configured = (review ? project.prompts.review : project.prompts.work)?
			.trimmingCharacters(in: .whitespacesAndNewlines)
		if let configured, !configured.isEmpty { return configured }
		return review ? FallbackPrompt.review : FallbackPrompt.work
	}
}

// MARK: - Git

/// An existing worktree of a project (GET /api/agent/git/worktrees). The main entry
/// is the repository itself, which the start sheet leaves out.
public struct WorktreeEntry: Codable, Hashable, Identifiable, Sendable {
	public var id: String { path }
	public let path: String
	public let branch: String
	public let isMain: Bool?

	public var name: String { (path as NSString).lastPathComponent }
}

/// One changed file in a session's diff against its base (GET /api/agent/sessions/{id}/diff).
public struct DiffFile: Codable, Hashable, Identifiable, Sendable {
	public var id: String { path }
	public let path: String
	public let oldPath: String?
	public let status: String
	public let additions: Int?
	public let deletions: Int?
	public let binary: Bool?
}

public struct DiffMeta: Codable, Hashable, Sendable {
	public let baseRef: String?
	public let baseResolved: Bool?
	public let truncated: Bool?
	public let fileCount: Int?
	public let additions: Int?
	public let deletions: Int?
	public let files: [DiffFile]?
}

public struct WorktreeDiff: Codable, Sendable {
	public let git: Bool
	public let patch: String?
	public let meta: DiffMeta?
}

// MARK: - Dev servers

public struct PortStatus: Codable, Hashable, Sendable {
	public let port: Int
	public let label: String?
	public let primary: Bool?
	public let listening: Bool?
}

public struct SetupStepProgress: Codable, Hashable, Sendable {
	public let label: String
	public let state: String
	public let exitCode: Int?
	public let output: String?
}

/// Live view of one configured dev server for a session's worktree.
public struct ServerRuntime: Codable, Hashable, Identifiable, Sendable {
	public var id: String { name }
	public let name: String
	public let state: String
	public let ports: [PortStatus]?
	public let previewUrl: String?
	public let setup: [SetupStepProgress]?
	public let error: String?
	public let warning: String?

	public var isRunning: Bool { state == "running" }
	public var canStop: Bool { ["setup", "starting", "running", "stalled"].contains(state) }
}

public struct ServersResponse: Codable, Sendable {
	public let servers: [ServerRuntime]
}

/// A tmux pane snapshot: a shell session's terminal or a dev server's log
/// pane. `unchanged` means the tag matched the previous poll and no text was
/// sent; `cleared` that the program cleared the screen and `text` is its last
/// non-empty output.
public struct TerminalSnapshot: Codable, Sendable {
	public let text: String?
	public let cleared: Bool?
	public let dead: Bool?
	public let h: String?
	public let unchanged: Bool?
}

public typealias ServerLogs = TerminalSnapshot
