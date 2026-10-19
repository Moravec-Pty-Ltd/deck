import Foundation
import Observation

/// Shared app state for the iOS and watchOS UIs and App Intents: session list,
/// pending asks, discovery data, and a resumable event-log loop.
@MainActor
@Observable
public final class DeckStore {
	public enum ConnectionState: Equatable, Sendable {
		case signedOut
		case connecting
		case live
		case offline(String)
	}

	public private(set) var client: DeckClient?
	public private(set) var connection: ConnectionState = .signedOut
	public private(set) var sessions: [SessionDigest] = []
	/// Pending questions: every session's, plus one per blocked workflow run
	/// (marked by `runId`), which is how a run gets answered like any ask.
	public private(set) var asks: [DeckAsk] = []
	/// Workflow run digests as deck last reported them. Empty on a deck without runs.
	public private(set) var runs: [RunDigest] = []
	/// The overseer session, when deck has one. Nil on a deck without runs.
	public private(set) var overseer: Overseer?
	/// What a run can be started as, fetched when a start form opens.
	public private(set) var workflows: [WorkflowDef] = []
	/// User workflow definitions deck skipped as malformed.
	public private(set) var workflowProblems: [String] = []
	public private(set) var projects: [DeckProject] = []
	public private(set) var kinds: [AgentKind] = []
	public private(set) var issuesByProject: [String: [DeckIssue]] = [:]
	public private(set) var prsByProject: [String: [DeckPR]] = [:]
	public private(set) var quickMessages: [QuickMessage] = []
	public private(set) var projectDetails: [String: ProjectDetail] = [:]
	/// The server-resolved start defaults per project path, fetched when a
	/// start surface opens.
	public private(set) var startDefaultsByProject: [String: ProjectStartDefaults] = [:]
	public private(set) var userLogin: String?
	/// The server's expensive-model list, from the last defaults it sent.
	public private(set) var expensiveModels: [String] = []
	/// What the server advertises on GET /api/agent. Nil until it first answers.
	public private(set) var serverInfo: ServerInfo?
	private var seq: Int?
	private var eventTask: Task<Void, Never>?

	public init() {
		if let credentials = CredentialStore.load() {
			client = DeckClient(credentials: credentials)
		}
	}

	/// A store on a given client, without the keychain, for tests.
	init(client: DeckClient) {
		self.client = client
	}

	public var isSignedIn: Bool { client != nil }

	public var awaitingCount: Int { asks.count }

	/// Whether the server offers a feature. Assumed until the server has said,
	/// so screens don't flicker on launch; a screen whose feature turns out to
	/// be missing hides it rather than calling a route that isn't there.
	public func supports(_ capability: DeckCapability) -> Bool {
		serverInfo?.supports(capability) ?? true
	}

	/// The capabilities in `needs` the server is known to lack.
	public func missing(_ needs: [DeckCapability]) -> [DeckCapability] {
		serverInfo?.missing(needs) ?? []
	}

	/// The server is older than this app: it lacks something the app uses, and
	/// those features are hidden until deck is updated.
	public var serverTooOld: Bool { !missing(DeckCapability.allCases).isEmpty }

	/// The runs board: what needs you first, finished runs last.
	public var board: [RunDigest] { RunBoard.sorted(runs) }

	/// The sessions the lists show: everything except what the user has hidden,
	/// most recently active first. deck decides what counts as hidden (the
	/// session itself, or the project it works in) and says so on the digest.
	public var activeSessions: [SessionDigest] {
		byRecency(sessions.filter { $0.hidden != true })
	}

	/// What the "Hidden" section at the bottom of the list holds. Empty until
	/// something is hidden, so the section only appears when it has contents.
	public var hiddenSessions: [SessionDigest] {
		byRecency(sessions.filter { $0.hidden == true })
	}

	private func byRecency(_ list: [SessionDigest]) -> [SessionDigest] {
		list.sorted { ($0.lastActiveAt ?? 0) > ($1.lastActiveAt ?? 0) }
	}

	// MARK: - Lifecycle

	public func signIn(_ credentials: Credentials) {
		CredentialStore.save(credentials)
		client = DeckClient(credentials: credentials)
		start()
	}

	public func signOut() {
		stopEventLoop()
		CredentialStore.delete()
		client = nil
		sessions = []
		asks = []
		runs = []
		overseer = nil
		serverInfo = nil
		connection = .signedOut
	}

	/// Bootstrap state and begin following the event log. Safe to call repeatedly
	/// (e.g. on foreground); it restarts the long-poll loop.
	public func start() {
		guard let client else { return }
		stopEventLoop()
		connection = .connecting
		eventTask = Task { [weak self] in
			await self?.runEventLoop(client: client)
		}
		Task { await refreshAsks() }
		Task { await refreshRuns() }
		Task { await refreshProjects() }
		Task { await refreshKinds() }
		// These routes are capability-gated, so they wait for the server's answer.
		Task {
			await refreshServerInfo()
			async let quick: Void = refreshQuickMessages()
			async let details: Void = refreshProjectDetails()
			async let user: Void = refreshUser()
			_ = await (quick, details, user)
		}
	}

	/// Ask the server what it supports. A failure keeps what was known before.
	public func refreshServerInfo() async {
		guard let client else { return }
		if let info = try? await client.serverInfo() { serverInfo = info }
	}

	public func refreshQuickMessages() async {
		guard let client, supports(.quickMessages) else { return }
		if let fresh = try? await client.quickMessages() { quickMessages = fresh }
	}

	public func refreshUser() async {
		guard let client, supports(.user) else { return }
		if let login = try? await client.currentUserLogin() { userLogin = login }
	}

	/// Mirrors deck's canMergePr: allow merge only for your own PR (or when the
	/// author/user is unknown). Hides the merge button on review sessions.
	public func canMerge(_ pr: SessionPR) -> Bool {
		guard let author = pr.author, let me = userLogin else { return true }
		return author == me
	}

	public func refreshProjectDetails() async {
		guard let client, supports(.projectConfig) else { return }
		if let fresh = try? await client.projectDetails() {
			projectDetails = Dictionary(uniqueKeysWithValues: fresh.map { ($0.path, $0) })
		}
	}

	/// Fetch (or refresh) what a new session in a project starts with, as the
	/// server resolves it. A failed fetch keeps whatever was cached.
	@discardableResult
	public func loadStartDefaults(projectPath: String) async -> ProjectStartDefaults? {
		guard let client else { return nil }
		if let fresh = try? await client.startDefaults(project: projectPath) {
			startDefaultsByProject[projectPath] = fresh
			if let list = fresh.expensiveModels { expensiveModels = list }
		}
		return startDefaultsByProject[projectPath]
	}

	/// Everything the web new-session modal preselects for a kind (model, effort,
	/// base branch, first prompt, permission mode), from the last fetched
	/// server defaults. Call `loadStartDefaults` first.
	public func startDefaults(kind: String, projectPath: String, review: Bool = false) -> StartDefaults {
		StartDefaults.resolve(kind: kind, review: review, project: startDefaultsByProject[projectPath])
	}

	/// Save a project's automation config and keep the local record current.
	public func saveAutomation(projectPath: String, automation: ProjectAutomation) async throws {
		guard let client else { throw DeckError.notConfigured }
		projectDetails[projectPath] = try await client.saveAutomation(projectPath: projectPath, automation: automation)
	}

	public func changeEffort(sessionId: String, effort: String?) async throws {
		guard let client else { throw DeckError.notConfigured }
		try await client.changeEffort(sessionId: sessionId, effort: effort)
		await refreshSessions()
	}

	public func sendImages(sessionId: String, text: String, images: [DeckImage]) async throws {
		guard let client else { throw DeckError.notConfigured }
		try await client.sendMessage(sessionId: sessionId, text: text, images: images)
	}

	public func saveQuickMessages(_ messages: [QuickMessage]) async throws {
		guard let client else { throw DeckError.notConfigured }
		quickMessages = try await client.saveQuickMessages(messages)
	}

	public func sendQuickMessage(sessionId: String, text: String) async throws {
		guard let client else { throw DeckError.notConfigured }
		try await client.sendQuickMessage(sessionId: sessionId, text: text)
	}

	public func refreshKinds() async {
		guard let client else { return }
		if let fresh = try? await client.kinds() { kinds = fresh }
	}

	/// Models the given agent kind enumerates (empty for kinds like claude that
	/// take a free-text model id).
	public func models(for kind: String) -> [String] {
		kinds.first { $0.kind == kind }?.models?.map(\.model) ?? []
	}

	/// Known models to offer in pickers: for claude, the built-in shortnames plus
	/// any locally-configured model profiles the server reports (those point a
	/// session at another backend and are only defined in the user's deck
	/// settings, so they never appear in either repo's source). Other kinds use
	/// whatever their CLI enumerates.
	public func knownModels(for kind: String) -> [String] {
		DeckModels.merge(kind: kind, enumerated: models(for: kind))
	}

	public func changeAgent(sessionId: String, kind: String) async throws {
		guard let client else { throw DeckError.notConfigured }
		try await client.changeAgent(sessionId: sessionId, kind: kind)
		await refreshSessions()
	}

	public func changeModel(sessionId: String, model: String?) async throws {
		guard let client else { throw DeckError.notConfigured }
		try await client.changeModel(sessionId: sessionId, model: model)
		await refreshSessions()
	}

	/// Fetch the expensive-model list if it hasn't arrived yet. It rides on a
	/// project's start defaults, so any registered project answers it.
	public func loadExpensiveModels(projectPath: String? = nil) async {
		guard supports(.expensiveModels), expensiveModels.isEmpty,
			let path = projectPath ?? projects.first?.path else { return }
		await loadStartDefaults(projectPath: path)
	}

	/// Whether picking `model` for a `kind` session should confirm first, by
	/// the server's list and its marked model rows.
	public func needsExpensiveConfirm(model: String?, provider: String? = nil, kind: String, current: String? = nil) -> Bool {
		guard supports(.expensiveModels) else { return false }
		let rows = kinds.first { $0.kind == kind }?.models ?? []
		return ExpensiveModels.needsConfirm(model: model, provider: provider, current: current, list: expensiveModels, rows: rows)
	}

	public func restart(sessionId: String) async throws {
		guard let client else { throw DeckError.notConfigured }
		try await client.restart(sessionId: sessionId)
		await refreshSessions()
	}

	public func dismissPR(sessionId: String) async throws {
		guard let client else { throw DeckError.notConfigured }
		try await client.dismissPR(sessionId: sessionId)
		await refreshSessions()
	}

	public func compact(sessionId: String) async throws {
		guard let client else { throw DeckError.notConfigured }
		try await client.compact(sessionId: sessionId)
		await refreshSessions()
	}

	/// Renames a session and returns the id it now has, which differs from the
	/// one passed in only for a renamed tmux terminal (see DeckClient.rename).
	@discardableResult
	public func rename(sessionId: String, title: String) async throws -> String {
		guard let client else { throw DeckError.notConfigured }
		let id = try await client.rename(sessionId: sessionId, title: title)
		await refreshSessions()
		return id
	}

	/// Hide or unhide one session. Refreshes both lists, since the session moves
	/// between them.
	public func setHidden(sessionId: String, hidden: Bool) async throws {
		guard let client else { throw DeckError.notConfigured }
		try await client.setHidden(sessionId: sessionId, hidden: hidden)
		await refreshSessions()
	}

	/// Hide or unhide a project, which moves every session working in it too, so
	/// the projects list is refreshed alongside the sessions.
	public func setHidden(projectPath: String, hidden: Bool) async throws {
		guard let client else { throw DeckError.notConfigured }
		try await client.setHidden(projectPath: projectPath, hidden: hidden)
		await refreshProjects()
		await refreshSessions()
	}

	public func deleteSession(sessionId: String, deleteWorktree: Bool, deleteBranch: Bool) async throws {
		guard let client else { throw DeckError.notConfigured }
		try await client.deleteSession(
			sessionId: sessionId, deleteWorktree: deleteWorktree, deleteBranch: deleteBranch)
		await refreshSessions()
	}

	/// Deletes each session in turn and refreshes once at the end. A session
	/// that fails does not stop the rest; its id maps to the failure message in
	/// the returned dictionary (empty when everything went through).
	/// `onProgress` reports how many are done as they land.
	@discardableResult
	public func deleteSessions(
		sessionIds: [String], deleteWorktree: Bool, deleteBranch: Bool,
		onProgress: ((Int) -> Void)? = nil
	) async throws -> [String: String] {
		guard let client else { throw DeckError.notConfigured }
		var failures: [String: String] = [:]
		for (index, sessionId) in sessionIds.enumerated() {
			do {
				try await client.deleteSession(
					sessionId: sessionId, deleteWorktree: deleteWorktree, deleteBranch: deleteBranch)
			} catch {
				failures[sessionId] = error.localizedDescription
			}
			onProgress?(index + 1)
		}
		await refreshSessions()
		return failures
	}

	public func stopEventLoop() {
		eventTask?.cancel()
		eventTask = nil
	}

	private func runEventLoop(client: DeckClient) async {
		while !Task.isCancelled {
			do {
				let response = try await client.events(since: seq, wait: seq != nil)
				apply(response)
				connection = .live
			} catch is CancellationError {
				return
			} catch {
				if Task.isCancelled { return }
				connection = .offline(error.localizedDescription)
				try? await Task.sleep(for: .seconds(5))
			}
		}
	}

	func apply(_ response: EventsResponse) {
		if let snapshot = response.snapshot {
			sessions = snapshot
		}
		// The snapshot covers sessions only; after a gap the run-updated events
		// it skipped are gone too, so re-read the runs.
		if response.gap == true { Task { await refreshRuns() } }
		for event in response.events ?? [] {
			apply(event)
			onFeedEvent?(event)
		}
		seq = response.seq
	}

	/// Called for every event the long-poll delivers, after the store has
	/// applied it. The operator listens here to speak up on its own (a new
	/// question, a finished turn), which used to arrive on its own SSE stream
	/// from deck; now that the operator thinks on the device, the event log it
	/// already follows is the only feed it needs.
	public var onFeedEvent: (@MainActor (DeckEvent) -> Void)?

	private func apply(_ event: DeckEvent) {
		switch event.type {
		case "session-created":
			if let digest = event.session, !sessions.contains(where: { $0.id == digest.id }) {
				sessions.append(digest)
			}
		case "session-hidden":
			// A project's hide arrives as one of these per session it owns, with
			// the project named, so the projects list follows without a fetch.
			if let path = event.project, let index = projects.firstIndex(where: { $0.path == path }) {
				projects[index].hidden = event.projectHidden == true ? true : nil
			}
			if let sessionId = event.sessionId,
				let index = sessions.firstIndex(where: { $0.id == sessionId }) {
				sessions[index].hidden = event.hidden == true ? true : nil
			}
		case "session-deleted":
			sessions.removeAll { $0.id == event.sessionId }
			asks.removeAll { $0.runId == nil && $0.sessionId == event.sessionId }
		case "run-updated":
			// The event names the run; the digest is fetched, never derived here.
			if let runId = event.runId ?? event.sessionId { Task { await refreshRun(id: runId) } }
			Task { await refreshOverseer() }
		case "run-deleted":
			if let runId = event.runId ?? event.sessionId {
				runs.removeAll { $0.id == runId }
				asks.removeAll { $0.runId == runId }
			}
		default:
			guard let sessionId = event.sessionId,
				let index = sessions.firstIndex(where: { $0.id == sessionId }) else { return }
			if let status = event.status { sessions[index].status = status }
			if let awaiting = event.awaitingInput {
				sessions[index].awaitingInput = awaiting
				if awaiting, let questions = event.questions {
					let ask = DeckAsk(
						sessionId: sessionId, source: event.source, askId: event.askId,
						askedAt: event.at, questions: questions)
					asks.removeAll { $0.runId == nil && $0.sessionId == sessionId }
					asks.append(ask)
				} else if !awaiting {
					asks.removeAll { $0.runId == nil && $0.sessionId == sessionId }
				}
			}
			if let pr = event.pr { sessions[index].pr = pr }
			if let cost = event.cost { sessions[index].cost = cost }
			if let at = event.at { sessions[index].lastActiveAt = at }
		}
	}

	// MARK: - Refresh

	public func refreshSessions() async {
		guard let client else { return }
		if let fresh = try? await client.sessions() { sessions = fresh }
	}

	public func refreshAsks() async {
		guard let client else { return }
		if let fresh = try? await client.asks() { asks = fresh }
	}

	public func refreshRuns() async {
		guard let client else { return }
		guard let fresh = try? await client.runs() else { return }
		runs = fresh
		asks.removeAll { $0.runId != nil }
		asks.append(contentsOf: fresh.compactMap(\.ask))
		await refreshOverseer()
	}

	/// Fetched when a start form opens rather than at sign-in: a deck without
	/// runs answers 404, and nothing else needs the list.
	public func refreshWorkflows() async {
		guard let client else { return }
		guard let fresh = try? await client.workflows() else { return }
		workflows = fresh.workflows
		workflowProblems = fresh.problems ?? []
	}

	/// Start a run and return it, so the caller can open it straight away.
	public func startRun(
		cwd: String,
		workflow: WorkflowDef,
		issue: DeckIssue? = nil,
		pr: DeckPR? = nil,
		base: String? = nil
	) async throws -> RunDigest {
		guard let client else { throw DeckError.notConfigured }
		let run = try await client.startRun(
			cwd: cwd, workflow: workflow.id, category: workflow.category,
			issue: issue, pr: pr, base: base)
		await refreshRuns()
		return run
	}

	/// A deck without an overseer answers 404; any other failure keeps the last
	/// known overseer rather than dropping its row.
	public func refreshOverseer() async {
		guard let client else { return }
		do {
			overseer = try await client.overseer()
		} catch DeckError.http(let status, _) where status == 404 {
			overseer = nil
		} catch {}
	}

	public func refreshRun(id: String) async {
		guard let client else { return }
		do {
			apply(try await client.run(id: id))
		} catch DeckError.http(let status, _) where status == 404 {
			runs.removeAll { $0.id == id }
			asks.removeAll { $0.runId == id }
		} catch {}
	}

	/// Take deck's digest for a run. An older digest than the one held (two
	/// fetches landing out of order) is dropped.
	private func apply(_ digest: RunDigest) {
		if let index = runs.firstIndex(where: { $0.id == digest.id }) {
			guard digest.updatedAt >= runs[index].updatedAt else { return }
			runs[index] = digest
		} else {
			runs.insert(digest, at: 0)
		}
		asks.removeAll { $0.runId == digest.id }
		if let ask = digest.ask { asks.append(ask) }
	}

	public func refreshProjects() async {
		guard let client else { return }
		if let fresh = try? await client.projects() { projects = fresh }
	}

	public func refreshIssues(project: String, refresh: Bool = false) async {
		guard let client else { return }
		if let response = try? await client.issues(project: project, refresh: refresh) {
			issuesByProject[project] = response.issues
		}
	}

	public func refreshPRs(project: String) async {
		guard let client else { return }
		if let response = try? await client.prs(project: project) {
			prsByProject[project] = response.prs
		}
	}

	// MARK: - Actions

	/// Start a work session for an issue. Options default to a plain claude
	/// session (one-tap from the watch); the iOS start sheet passes the full set.
	/// `cwd` overrides the project path to start inside an existing worktree.
	@discardableResult
	/// Start a work session. `issue` is optional: without one the session is
	/// just a project, a first prompt and a branch.
	public func startWork(
		issue: DeckIssue? = nil,
		additionalIssues: [DeckIssue] = [],
		project: DeckProject,
		prompt: String? = nil,
		kind: String? = nil,
		title: String? = nil,
		model: String? = nil,
		provider: String? = nil,
		effort: String? = nil,
		permissionMode: String? = nil,
		worktree: WorktreeOptions? = nil,
		cwd: String? = nil,
		idempotencyKey: String = UUID().uuidString
	) async throws -> CreateSessionResponse {
		guard let client else { throw DeckError.notConfigured }
		let response = try await client.createWorkSession(
			cwd: cwd ?? project.path,
			prompt: prompt,
			kind: kind,
			title: title,
			model: model,
			provider: provider,
			effort: effort,
			permissionMode: permissionMode,
			worktree: worktree,
			issue: issue,
			additionalIssues: additionalIssues,
			idempotencyKey: idempotencyKey)
		await refreshSessions()
		return response
	}

	/// Start a terminal in a project: a deck-managed tmux shell, no agent.
	@discardableResult
	public func startShell(project: DeckProject, idempotencyKey: String = UUID().uuidString) async throws -> CreateSessionResponse {
		guard let client else { throw DeckError.notConfigured }
		let response = try await client.createShellSession(cwd: project.path, idempotencyKey: idempotencyKey)
		await refreshSessions()
		return response
	}

	/// Start a review session for a PR.
	@discardableResult
	public func startReview(
		pr: DeckPR,
		project: DeckProject,
		prompt: String? = nil,
		kind: String? = nil,
		model: String? = nil,
		provider: String? = nil,
		effort: String? = nil,
		permissionMode: String? = nil,
		idempotencyKey: String = UUID().uuidString
	) async throws -> CreateSessionResponse {
		guard let client else { throw DeckError.notConfigured }
		let response = try await client.createReviewSession(
			cwd: project.path,
			pr: pr,
			prompt: prompt,
			kind: kind,
			model: model,
			provider: provider,
			effort: effort,
			permissionMode: permissionMode,
			idempotencyKey: idempotencyKey)
		await refreshSessions()
		return response
	}

	public func answer(ask: DeckAsk, text: String, answers: [StructuredAnswer] = []) async throws {
		guard let client else { throw DeckError.notConfigured }
		if let runId = ask.runId {
			// A run hands the reply to its next phase session as is, so it gets the
			// words rather than the "Answering your question" wrapper.
			let reply = answers.flatMap(\.labels).joined(separator: ", ")
			apply(try await client.runAction(id: runId, .answer, text: reply.isEmpty ? text : reply))
			return
		}
		let response = try await client.answer(sessionId: ask.sessionId, text: text, askId: ask.askId, answers: answers)
		if response.ok {
			asks.removeAll { $0.id == ask.id }
		} else if let reason = response.reason {
			throw DeckError.http(status: 200, message: reason)
		}
	}

	/// Post an action on a run and show the digest deck answers with. Nothing
	/// about the run changes here until deck says so.
	public func runAction(_ action: RunAction, run id: String, phase: String? = nil) async throws {
		guard let client else { throw DeckError.notConfigured }
		apply(try await client.runAction(id: id, action, phase: phase))
	}

	public func deleteRun(id: String) async throws {
		guard let client else { throw DeckError.notConfigured }
		try await client.deleteRun(id: id)
		runs.removeAll { $0.id == id }
		asks.removeAll { $0.runId == id }
	}

	/// Clear finished runs off the board, then re-read it: deck decides which
	/// ones counted as finished.
	@discardableResult
	public func deleteFinishedRuns() async throws -> Int {
		guard let client else { throw DeckError.notConfigured }
		let deleted = try await client.deleteFinishedRuns()
		await refreshRuns()
		return deleted
	}

	public func send(sessionId: String, text: String) async throws {
		guard let client else { throw DeckError.notConfigured }
		try await client.send(sessionId: sessionId, text: text)
	}

	public func stop(sessionId: String) async throws {
		guard let client else { throw DeckError.notConfigured }
		try await client.stop(sessionId: sessionId)
	}
}
