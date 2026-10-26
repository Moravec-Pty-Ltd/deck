import Foundation

public enum DeckError: Error, LocalizedError {
	case http(status: Int, message: String)
	case invalidResponse
	case notConfigured
	/// A create's 409 for a leftover worktree branch (code and branch), which
	/// the caller can answer with `WorktreeOptions.onExisting`.
	case worktreeConflict(WorktreeConflict)
	/// deck took the request but turned the answer down (`ok: false`), with
	/// its reason, e.g. the question was already answered.
	case answerDeclined(reason: String)

	public var errorDescription: String? {
		switch self {
		case .http(let status, let message): return "\(message) (HTTP \(status))"
		case .worktreeConflict(let conflict): return conflict.message
		case .answerDeclined(let reason): return reason
		case .invalidResponse: return "Invalid response from deck"
		case .notConfigured: return "deck is not signed in"
		}
	}
}

extension DeckError {
	/// What a form shows for a failure: the server's own message as it sent
	/// it (a 400 or 403 says what to fix), anything else as described.
	public static func message(for error: Error) -> String {
		if case DeckError.http(_, let message) = error { return message }
		return error.localizedDescription
	}
}

public struct Credentials: Codable, Equatable, Sendable {
	public let baseURL: URL
	public let token: String

	public init(baseURL: URL, token: String) {
		self.baseURL = baseURL
		self.token = token
	}
}

/// Client for deck's stable agent API (documented at GET /llms.txt).
public final class DeckClient: @unchecked Sendable {
	public let credentials: Credentials
	let session: URLSession
	private let decoder = JSONDecoder()

	public init(credentials: Credentials, configuration: URLSessionConfiguration? = nil) {
		self.credentials = credentials
		let config = configuration ?? URLSessionConfiguration.ephemeral
		// Long-poll (?wait=1) holds up to ~25s; leave headroom.
		config.timeoutIntervalForRequest = 40
		config.timeoutIntervalForResource = 120
		self.session = URLSession(configuration: config)
	}

	// MARK: - Discovery

	public func projects() async throws -> [DeckProject] {
		try await get("/api/agent/projects")
	}

	public func kinds() async throws -> [AgentKind] {
		try await get("/api/agent/kinds")
	}

	public func issues(project: String, refresh: Bool = false) async throws -> IssuesResponse {
		try await get("/api/agent/issues", query: [
			URLQueryItem(name: "project", value: project)
		] + (refresh ? [URLQueryItem(name: "refresh", value: "1")] : []))
	}

	public func prs(project: String) async throws -> PRsResponse {
		try await get("/api/agent/prs", query: [URLQueryItem(name: "project", value: project)])
	}

	/// What a new session in a project starts with when nothing is picked (the
	/// web modal's preselection), resolved by the server.
	public func startDefaults(project: String) async throws -> ProjectStartDefaults {
		try await get("/api/agent/defaults", query: [URLQueryItem(name: "project", value: project)])
	}

	/// Existing worktrees of a project, for starting a session inside one.
	public func worktrees(repo: String) async throws -> [WorktreeEntry] {
		try await get("/api/agent/git/worktrees", query: [URLQueryItem(name: "repo", value: repo)])
	}

	/// Local branch names of a project, for the base-branch picker.
	public func branches(repo: String) async throws -> [String] {
		try await get("/api/agent/git/branches", query: [URLQueryItem(name: "repo", value: repo)])
	}

	/// The signed-in gh login (nil if gh can't resolve it), used to gate merge
	/// to your own PRs.
	public func currentUserLogin() async throws -> String? {
		struct UserResponse: Decodable { let login: String? }
		let response: UserResponse = try await get("/api/agent/user")
		return response.login
	}

	/// Every project's full stored record (name, group, automation).
	public func projectDetails() async throws -> [ProjectDetail] {
		try await get("/api/agent/projects/config")
	}

	/// Save a project's automation config. The PATCH changes only the fields it
	/// names, so nothing else on the record needs to ride along.
	@discardableResult
	public func saveAutomation(projectPath: String, automation: ProjectAutomation) async throws -> ProjectDetail {
		let body: [String: Any] = ["path": projectPath, "automation": automation.json]
		let data = try await requestData("PATCH", "/api/agent/projects/config", body: body)
		return try decoder.decode(ProjectDetail.self, from: data)
	}

	// MARK: - Projects

	/// Register an existing directory. Re-registering a path keeps every field
	/// left out.
	public func registerProject(path: String, name: String? = nil, group: String? = nil) async throws -> ProjectDetail {
		try await post("/api/agent/projects", json: Self.compact(["path": path, "name": name, "group": group]))
	}

	/// Clone `url` into `parent/<repo name>` and register it. The clone runs
	/// before the reply, so it gets longer than the usual request timeout.
	public func cloneProject(url: String, parent: String, name: String? = nil, group: String? = nil) async throws -> ProjectDetail {
		let body = Self.compact(["url": url, "parent": parent, "name": name, "group": group])
		let data = try await requestData("POST", "/api/agent/projects/clone", body: body, timeout: 120)
		return try decoder.decode(ProjectDetail.self, from: data)
	}

	/// Unregister a project. Its folder, worktrees and sessions stay as they are.
	public func removeProject(path: String) async throws {
		_ = try await requestData("DELETE", "/api/agent/projects", query: [URLQueryItem(name: "path", value: path)])
	}

	/// PATCH the named fields of a project's config and return the stored record.
	public func updateProject(path: String, changes: [String: String]) async throws -> ProjectDetail {
		var body: [String: Any] = changes
		body["path"] = path
		let data = try await requestData("PATCH", "/api/agent/projects/config", body: body)
		return try decoder.decode(ProjectDetail.self, from: data)
	}

	/// Replace a project's dev-server config. A shape the server rejects is a
	/// 400 whose message names the problem.
	public func saveDevConfig(path: String, dev: DevConfig) async throws -> ProjectDetail {
		let body: [String: Any] = ["path": path, "dev": try dev.jsonObject()]
		let data = try await requestData("PATCH", "/api/agent/projects/config", body: body)
		return try decoder.decode(ProjectDetail.self, from: data)
	}

	/// Folder suggestions for a path being typed, `~`-collapsed.
	public func completePath(_ partial: String) async throws -> [String] {
		try await get("/api/agent/fs/complete", query: [URLQueryItem(name: "q", value: partial)])
	}

	private static func compact(_ fields: [String: String?]) -> [String: Any] {
		fields.compactMapValues { value in
			guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
			return value
		}
	}

	// MARK: - Sessions

	public func sessions() async throws -> [SessionDigest] {
		try await get("/api/agent/sessions")
	}

	public func session(id: String) async throws -> SessionDetail {
		try await get("/api/agent/sessions/\(id)")
	}

	public func transcript(sessionId: String) async throws -> Transcript {
		try await get("/api/agent/sessions/\(sessionId)/transcript")
	}

	/// Older transcript history for back-scroll: the `limit` raw events just
	/// before absolute index `before`, oldest first, with the index of the first.
	public func transcriptRange(sessionId: String, before: Int, limit: Int = 250) async throws -> TranscriptSlice {
		try await get("/api/agent/sessions/\(sessionId)/history", query: [
			URLQueryItem(name: "before", value: String(before)),
			URLQueryItem(name: "limit", value: String(limit))
		])
	}

	/// The bytes of an attachment a message carried, stored by deck out-of-band.
	public func imageData(sessionId: String, file: String) async throws -> Data {
		try await getData("/api/agent/sessions/\(sessionId)/images/\(file)")
	}

	/// The session's diff against its base branch (the web Changes tab).
	public func diff(sessionId: String) async throws -> WorktreeDiff {
		try await get("/api/agent/sessions/\(sessionId)/diff")
	}

	// MARK: - Dev servers

	/// Every session's dev-server states, from the monitor's last poll. One cheap
	/// call, so a browser that spans sessions does not have to ask each of them
	/// whether it has anything running.
	public func serverStates() async throws -> [String: [String]] {
		try await get("/api/agent/servers")
	}

	public func servers(sessionId: String) async throws -> [ServerRuntime] {
		let response: ServersResponse = try await get("/api/agent/sessions/\(sessionId)/servers")
		return response.servers
	}

	/// start / stop / restart / resetup one configured server, or re-run a single
	/// setup step (`step` index with the label shown, so a stale list is caught).
	public func serverAction(sessionId: String, name: String, action: String, step: Int? = nil, label: String? = nil) async throws {
		var body: [String: Any] = ["action": action]
		if let step { body["step"] = step }
		if let label { body["label"] = label }
		_ = try await postRaw("/api/agent/sessions/\(sessionId)/servers/\(seg(name))", json: body)
	}

	/// A server's log pane. Pass the previous `h` tag to get `unchanged` back
	/// instead of the same text.
	public func serverLogs(sessionId: String, name: String, tag: String?) async throws -> ServerLogs {
		try await get("/api/agent/sessions/\(sessionId)/servers/\(seg(name))/logs", query: tag.map { [URLQueryItem(name: "h", value: $0)] } ?? [])
	}

	// MARK: - Terminals

	/// A shell session's screen, ANSI and all. Pass the previous `h` tag to get
	/// `unchanged` back instead of the same text.
	public func terminal(sessionId: String, tag: String?, lines: Int? = nil) async throws -> TerminalSnapshot {
		var query: [URLQueryItem] = []
		if let lines { query.append(URLQueryItem(name: "lines", value: String(lines))) }
		if let tag { query.append(URLQueryItem(name: "h", value: tag)) }
		return try await get("/api/agent/sessions/\(sessionId)/terminal", query: query)
	}

	/// Type literal text into a shell session, pressing Enter after it unless
	/// `submit` is false. Empty text with submit is a bare Enter.
	public func typeInTerminal(sessionId: String, text: String, submit: Bool = true) async throws {
		_ = try await postRaw("/api/agent/sessions/\(sessionId)/terminal", json: ["text": text, "submit": submit])
	}

	public func pressInTerminal(sessionId: String, key: TerminalKey) async throws {
		_ = try await postRaw("/api/agent/sessions/\(sessionId)/terminal", json: ["key": key.name])
	}

	/// Start a deck-managed tmux terminal in `cwd`.
	public func createShellSession(cwd: String, title: String? = nil, idempotencyKey: String? = nil) async throws -> CreateSessionResponse {
		var body: [String: Any] = ["mode": "shell", "cwd": cwd]
		if let title { body["title"] = title }
		return try await post("/api/agent/sessions", json: body, idempotencyKey: idempotencyKey)
	}

	public func createWorkSession(
		cwd: String,
		prompt: String? = nil,
		kind: String? = nil,
		title: String? = nil,
		model: String? = nil,
		provider: String? = nil,
		effort: String? = nil,
		permissionMode: String? = nil,
		worktree: WorktreeOptions? = nil,
		issue: DeckIssue? = nil,
		additionalIssues: [DeckIssue] = [],
		idempotencyKey: String? = nil
	) async throws -> CreateSessionResponse {
		var request = CreateSessionRequest(mode: .work, cwd: cwd)
		request.prompt = prompt
		request.kind = kind
		request.title = title
		request.model = model
		request.provider = provider
		request.effort = effort
		request.permissionMode = permissionMode
		request.worktree = worktree
		request.issues = issue.map { [$0] + additionalIssues } ?? []
		return try await createSession(request, idempotencyKey: idempotencyKey)
	}

	public func createReviewSession(
		cwd: String,
		pr: DeckPR,
		prompt: String? = nil,
		kind: String? = nil,
		model: String? = nil,
		provider: String? = nil,
		effort: String? = nil,
		permissionMode: String? = nil,
		idempotencyKey: String? = nil
	) async throws -> CreateSessionResponse {
		var request = CreateSessionRequest(mode: .review, cwd: cwd)
		request.pr = pr
		request.prompt = prompt
		request.kind = kind
		request.model = model
		request.provider = provider
		request.effort = effort
		request.permissionMode = permissionMode
		return try await createSession(request, idempotencyKey: idempotencyKey)
	}

	/// POST /api/agent/sessions. A leftover worktree branch throws
	/// `DeckError.worktreeConflict`; retry under the same key with
	/// `worktree.onExisting` set.
	public func createSession(_ request: CreateSessionRequest, idempotencyKey: String? = nil) async throws -> CreateSessionResponse {
		try await post("/api/agent/sessions", json: request.json, idempotencyKey: idempotencyKey)
	}

	/// `voice` marks a message spoken in voice mode, so the agent answers in a
	/// way that reads well aloud.
	@discardableResult
	public func send(sessionId: String, text: String, voice: Bool = false) async throws -> MessageResponse {
		var json: [String: Any] = ["text": text]
		if voice { json["voice"] = true }
		return try await post("/api/agent/sessions/\(sessionId)/message", json: json)
	}

	@discardableResult
	public func stop(sessionId: String) async throws -> MessageResponse {
		try await post("/api/agent/sessions/\(sessionId)/stop", json: [:])
	}

	/// Answer a blocking question. `answers` (one per question) persists the
	/// picks on the transcript, keyed to `askId`, so every client shows the
	/// question answered with those labels.
	@discardableResult
	public func answer(sessionId: String, text: String, askId: String? = nil, answers: [StructuredAnswer] = []) async throws -> AnswerResponse {
		var body: [String: Any] = ["text": text]
		if let askId { body["askId"] = askId }
		if !answers.isEmpty { body["answers"] = answers.map { ["header": $0.header, "labels": $0.labels] } }
		return try await post("/api/agent/sessions/\(sessionId)/answer", json: body)
	}

	@discardableResult
	public func review(sessionId: String, decision: String, body reviewBody: String?) async throws -> Data {
		var body: [String: Any] = ["decision": decision]
		if let reviewBody { body["body"] = reviewBody }
		return try await postRaw("/api/agent/sessions/\(sessionId)/review", json: body)
	}

	@discardableResult
	public func merge(sessionId: String, method: String = "squash", deleteBranch: Bool = true) async throws -> Data {
		try await postRaw("/api/agent/sessions/\(sessionId)/merge", json: [
			"method": method, "deleteBranch": deleteBranch
		])
	}

	public func changeAgent(sessionId: String, kind: String) async throws {
		_ = try await postRaw("/api/agent/sessions/\(sessionId)/agent", json: ["kind": kind])
	}

	/// Switch a session's model. `model` nil/empty resets to the CLI default.
	/// Idle-only server-side (a running turn is a 409).
	public func changeModel(sessionId: String, model: String?) async throws {
		_ = try await postRaw("/api/agent/sessions/\(sessionId)/model", json: ["model": model ?? ""])
	}

	/// The skills installed on the deck machine, so the operator knows what it
	/// can ask a session to run.
	public func skills() async throws -> [DeckSkill] {
		struct Reply: Decodable { let skills: [DeckSkill] }
		let reply: Reply = try await get("/api/agent/skills")
		return reply.skills
	}

	/// One skill's text, or nil when the machine has no such skill.
	public func skillBody(name: String) async throws -> String? {
		struct Reply: Decodable { let body: String }
		do {
			let reply: Reply = try await get("/api/agent/skills/\(seg(name))")
			return reply.body
		} catch let DeckError.http(status, _) where status == 404 {
			return nil
		}
	}

	/// A message from the operator: deck resolves spoken skill phrasing ("run
	/// dev-workflow on ENG-1") into the command that runs it, against the
	/// skills that machine actually has.
	public func sendOperatorMessage(sessionId: String, text: String) async throws {
		_ = try await postRaw(
			"/api/agent/sessions/\(sessionId)/message",
			json: ["text": text, "skills": true])
	}

	/// Summarise a session's history and free its context window (claude's own
	/// `/compact`). Idle-only server-side; a running turn is a 409.
	public func compact(sessionId: String) async throws {
		_ = try await postRaw("/api/agent/sessions/\(sessionId)/compact", json: [:])
	}

	/// Drop a claude session's process so the next message respawns it with
	/// the current CLI config and resumes the conversation. Idle-only and
	/// claude-only server-side (409 while a turn runs, 400 for other kinds).
	public func restart(sessionId: String) async throws {
		_ = try await postRaw("/api/agent/sessions/\(sessionId)/restart", json: [:])
	}

	/// Forget the PR captured on a session. The next PR link the agent prints
	/// captures one again.
	public func dismissPR(sessionId: String) async throws {
		_ = try await requestData("DELETE", "/api/agent/sessions/\(sessionId)/pr")
	}

	/// Rename a session. Returns the id it now has: renaming an unregistered
	/// tmux terminal renames the tmux session, so deck's derived id moves with
	/// it and the caller has to follow.
	public func rename(sessionId: String, title: String) async throws -> String {
		let data = try await postRaw("/api/agent/sessions/\(sessionId)/title", json: ["title": title])
		return (try? JSONDecoder().decode(RenameResponse.self, from: data))?.id ?? sessionId
	}

	/// Move a session into the Hidden section, or bring it back. It keeps
	/// running and stops notifying; nothing is deleted.
	public func setHidden(sessionId: String, hidden: Bool) async throws {
		_ = try await postRaw("/api/agent/sessions/\(sessionId)/hidden", json: ["hidden": hidden])
	}

	/// Mark sessions read; unknown ids are ignored.
	public func markRead(sessionIds: [String]) async throws {
		_ = try await postRaw("/api/agent/sessions/read", json: ["ids": sessionIds])
	}

	/// Hide or unhide a project, which takes every session working in it, or in
	/// one of its worktrees, along with it.
	public func setHidden(projectPath: String, hidden: Bool) async throws {
		_ = try await postRaw("/api/agent/projects/hidden", json: ["path": projectPath, "hidden": hidden])
	}

	/// Switch a claude session's reasoning effort ("thinking level"). nil/empty
	/// resets to the CLI default.
	public func changeEffort(sessionId: String, effort: String?) async throws {
		_ = try await postRaw("/api/agent/sessions/\(sessionId)/effort", json: ["effort": effort ?? ""])
	}

	/// Share files with a session: deck writes them beside its own data (never
	/// into the worktree) and tells the session where they are, for the agent to
	/// read from disk. Images a model should *see* go through sendMessage's
	/// `images` instead; this is for everything else.
	public func upload(sessionId: String, files: [SharedFile], text: String?) async throws {
		var body: [String: Any] = [
			"files": files.map { ["name": $0.name, "data": $0.data.base64EncodedString()] }
		]
		if let text, !text.isEmpty { body["text"] = text }
		_ = try await postRaw("/api/agent/sessions/\(sessionId)/upload", json: body)
	}

	/// Send a message with image attachments. Literal text is preserved: no
	/// `expand`, so a bracketed word is not taken for a template token.
	public func sendMessage(sessionId: String, text: String, images: [DeckImage]) async throws {
		var body: [String: Any] = ["text": text]
		if !images.isEmpty {
			body["images"] = images.map { ["media_type": $0.mediaType, "data": $0.data] }
		}
		_ = try await postRaw("/api/agent/sessions/\(sessionId)/message", json: body)
	}

	public func deleteSession(sessionId: String, deleteWorktree: Bool, deleteBranch: Bool) async throws {
		var request = try request(path: "/api/agent/sessions/\(sessionId)", query: [
			URLQueryItem(name: "worktree", value: deleteWorktree ? "1" : "0"),
			URLQueryItem(name: "branch", value: deleteBranch ? "1" : "0")
		])
		request.httpMethod = "DELETE"
		let (data, response) = try await session.data(for: request)
		try check(data: data, response: response)
	}

	// MARK: - Quick messages

	public func quickMessages() async throws -> [QuickMessage] {
		try await get("/api/agent/quick-messages")
	}

	@discardableResult
	public func saveQuickMessages(_ messages: [QuickMessage]) async throws -> [QuickMessage] {
		let body: [[String: Any]] = messages.map { message in
			var dict: [String: Any] = ["id": message.id, "text": message.text]
			if let label = message.label, !label.isEmpty { dict["label"] = label }
			if let projectId = message.projectId, !projectId.isEmpty { dict["projectId"] = projectId }
			return dict
		}
		let data = try await requestData("PUT", "/api/agent/quick-messages", body: body)
		return try decoder.decode([QuickMessage].self, from: data)
	}

	/// Sends a quick message with `expand`, so deck fills in its [tokens]
	/// server-side.
	public func sendQuickMessage(sessionId: String, text: String) async throws {
		_ = try await postRaw("/api/agent/sessions/\(sessionId)/message", json: ["text": text, "expand": true])
	}

	public func asks() async throws -> [DeckAsk] {
		try await get("/api/agent/asks")
	}

	// MARK: - Workflow runs

	/// Every run's digest, newest first. Older deck servers have no runs and
	/// answer 404.
	public func runs() async throws -> [RunDigest] {
		try await get("/api/agent/runs")
	}

	public func run(id: String) async throws -> RunDigest {
		try await get("/api/agent/runs/\(seg(id))")
	}

	/// The workflows this deck can run, built-ins merged with the user's own.
	public func workflows() async throws -> WorkflowsResponse {
		try await get("/api/agent/workflows")
	}

	/// Start a run. A dev workflow takes an issue, a review workflow a PR; deck
	/// rejects the wrong pairing, so the form only has to offer the right one.
	/// The issue is sent whole rather than as a reference, because it carries
	/// the `sourceId` deck needs to read the issue's text for the first phase.
	@discardableResult
	public func startRun(
		cwd: String,
		workflow: String,
		category: String,
		issue: DeckIssue? = nil,
		pr: DeckPR? = nil,
		base: String? = nil
	) async throws -> RunDigest {
		var body: [String: Any] = ["cwd": cwd, "workflow": workflow, "category": category]
		if let issue {
			var dict: [String: Any] = ["source": issue.source, "id": issue.issueId]
			if let sourceId = issue.sourceId { dict["sourceId"] = sourceId }
			if let url = issue.url { dict["url"] = url }
			body["issue"] = dict
		}
		if let pr {
			var dict: [String: Any] = ["repo": pr.repo, "number": pr.number]
			if let url = pr.url { dict["url"] = url }
			if let title = pr.title { dict["title"] = title }
			body["pr"] = dict
		}
		if let base, !base.isEmpty { body["base"] = base }
		return try await post("/api/agent/runs", json: body)
	}

	/// Ask deck to act on a run and return the digest it ends up in. deck makes
	/// the transition; the client only names the action. `phase` is resume's
	/// target, `text` is answer's reply.
	@discardableResult
	public func runAction(id: String, _ action: RunAction, phase: String? = nil, text: String? = nil) async throws -> RunDigest {
		var body: [String: Any] = [:]
		if let phase { body["phase"] = phase }
		if let text { body["text"] = text }
		return try await post("/api/agent/runs/\(seg(id))/\(action.rawValue)", json: body)
	}

	public func overseer() async throws -> Overseer {
		try await get("/api/agent/overseer")
	}

	public func deleteRun(id: String) async throws {
		_ = try await requestData("DELETE", "/api/agent/runs/\(seg(id))")
	}

	/// Delete every done or cancelled run; returns how many went.
	public func deleteFinishedRuns() async throws -> Int {
		struct Reply: Decodable { let deleted: Int }
		let data = try await requestData("DELETE", "/api/agent/runs", query: [URLQueryItem(name: "finished", value: "1")])
		return try decoder.decode(Reply.self, from: data).deleted
	}

	// MARK: - Schedules

	/// Every schedule, newest first. Older deck servers have none and answer 404.
	public func schedules() async throws -> [DeckSchedule] {
		try await get("/api/agent/schedules")
	}

	/// What deck makes of a cron expression: the next few runs, or why it could
	/// not be read. Asked of the server so there is one cron engine rather than
	/// a second one here to keep in step with it.
	public func schedulePreview(cron: String, count: Int = 3) async throws -> SchedulePreview {
		try await get("/api/agent/schedules/preview", query: [
			URLQueryItem(name: "cron", value: cron),
			URLQueryItem(name: "count", value: String(count))
		])
	}

	@discardableResult
	public func createSchedule(_ draft: ScheduleDraft) async throws -> DeckSchedule {
		try await post("/api/agent/schedules", json: draft.json)
	}

	@discardableResult
	public func updateSchedule(id: String, _ draft: ScheduleDraft) async throws -> DeckSchedule {
		let data = try await requestData("PATCH", "/api/agent/schedules/\(seg(id))", body: draft.json)
		return try decoder.decode(DeckSchedule.self, from: data)
	}

	/// Pause or resume one, leaving everything else it carries alone.
	@discardableResult
	public func setScheduleEnabled(id: String, enabled: Bool) async throws -> DeckSchedule {
		let data = try await requestData("PATCH", "/api/agent/schedules/\(seg(id))", body: ["enabled": enabled])
		return try decoder.decode(DeckSchedule.self, from: data)
	}

	/// Run it now, whatever its due time says and whether or not it is enabled.
	/// Throws on deck's 409, which is it refusing while the last run is going.
	@discardableResult
	public func runScheduleNow(id: String) async throws -> DeckSchedule {
		try await post("/api/agent/schedules/\(seg(id))/run", json: [:])
	}

	public func deleteSchedule(id: String) async throws {
		_ = try await requestData("DELETE", "/api/agent/schedules/\(seg(id))")
	}

	// MARK: - Watches

	/// Every watch, or one session's.
	public func watches(sessionId: String? = nil) async throws -> [Watch] {
		struct Reply: Decodable { let watches: [Watch] }
		let query = sessionId.map { [URLQueryItem(name: "sessionId", value: $0)] } ?? []
		let reply: Reply = try await get("/api/agent/watches", query: query)
		return reply.watches
	}

	public func cancelWatch(id: String) async throws {
		_ = try await requestData("DELETE", "/api/agent/watches/\(seg(id))")
	}

	public func events(since: Int? = nil, wait: Bool = false) async throws -> EventsResponse {
		var query: [URLQueryItem] = []
		if let since { query.append(URLQueryItem(name: "since", value: String(since))) }
		if wait { query.append(URLQueryItem(name: "wait", value: "1")) }
		return try await get("/api/agent/events", query: query)
	}

	// MARK: - Push registration (deck APNs extension)

	public func registerAPNs(token: String, platform: String, env: String) async throws {
		_ = try await postRaw("/api/push/apns/register", json: [
			"token": token, "platform": platform, "env": env
		])
	}

	public func unregisterAPNs(token: String) async throws {
		_ = try await postRaw("/api/push/apns/unregister", json: ["token": token])
	}

	// MARK: - Plumbing

	private func seg(_ value: String) -> String {
		value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
	}

	func request(path: String, query: [URLQueryItem] = []) throws -> URLRequest {
		guard var components = URLComponents(url: credentials.baseURL, resolvingAgainstBaseURL: false) else {
			throw DeckError.invalidResponse
		}
		components.path = path
		if !query.isEmpty { components.queryItems = query }
		guard let url = components.url else { throw DeckError.invalidResponse }
		var request = URLRequest(url: url)
		request.setValue("Bearer \(credentials.token)", forHTTPHeaderField: "Authorization")
		return request
	}

	func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
		let (data, response) = try await session.data(for: request(path: path, query: query))
		return try decode(data: data, response: response)
	}

	/// Raw bytes of an authenticated GET (audio, images, files).
	func getData(_ path: String, query: [URLQueryItem] = []) async throws -> Data {
		let (data, response) = try await session.data(for: request(path: path, query: query))
		try check(data: data, response: response)
		return data
	}

	func post<T: Decodable>(_ path: String, json: [String: Any], idempotencyKey: String? = nil) async throws -> T {
		let data = try await postRaw(path, json: json, idempotencyKey: idempotencyKey)
		return try decoder.decode(T.self, from: data)
	}

	/// POST a binary body under its own content type (a recording) and decode
	/// the JSON reply.
	func upload<T: Decodable>(_ path: String, body: Data, contentType: String) async throws -> T {
		var request = try request(path: path)
		request.httpMethod = "POST"
		request.setValue(contentType, forHTTPHeaderField: "Content-Type")
		let (data, response) = try await session.upload(for: request, from: body)
		return try decode(data: data, response: response)
	}

	func postRaw(_ path: String, json: [String: Any], idempotencyKey: String? = nil) async throws -> Data {
		var request = try request(path: path)
		request.httpMethod = "POST"
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		if let idempotencyKey { request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key") }
		request.httpBody = try JSONSerialization.data(withJSONObject: json)
		let (data, response) = try await session.data(for: request)
		try check(data: data, response: response)
		return data
	}

	/// Arbitrary method + JSON body (object or array), returning raw validated data.
	func requestData(
		_ method: String, _ path: String, query: [URLQueryItem] = [], body: Any? = nil, timeout: TimeInterval? = nil
	) async throws -> Data {
		var request = try request(path: path, query: query)
		request.httpMethod = method
		if let timeout { request.timeoutInterval = timeout }
		if let body {
			request.setValue("application/json", forHTTPHeaderField: "Content-Type")
			request.httpBody = try JSONSerialization.data(withJSONObject: body)
		}
		let (data, response) = try await session.data(for: request)
		try check(data: data, response: response)
		return data
	}

	private func decode<T: Decodable>(data: Data, response: URLResponse) throws -> T {
		try check(data: data, response: response)
		return try decoder.decode(T.self, from: data)
	}

	private func check(data: Data, response: URLResponse) throws {
		guard let http = response as? HTTPURLResponse else { throw DeckError.invalidResponse }
		guard (200..<300).contains(http.statusCode) else {
			let body = try? decoder.decode(APIErrorBody.self, from: data)
			if let conflict = WorktreeConflict(status: http.statusCode, body: body) {
				throw DeckError.worktreeConflict(conflict)
			}
			throw DeckError.http(status: http.statusCode, message: body?.message ?? "deck request failed")
		}
	}
}
