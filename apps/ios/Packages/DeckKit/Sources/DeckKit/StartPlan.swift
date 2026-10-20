import Foundation

/// One POST /api/agent/sessions body, work or review.
public struct CreateSessionRequest: Equatable, Sendable {
	public enum Mode: String, Sendable {
		case work
		case review
	}

	public var mode: Mode
	public var cwd: String
	public var prompt: String?
	public var kind: String?
	public var title: String?
	public var model: String?
	public var provider: String?
	public var effort: String?
	public var permissionMode: String?
	/// Work only: review makes its worktree from the PR head.
	public var worktree: WorktreeOptions?
	/// Work only. The first is also sent as the legacy single `issue`.
	public var issues: [DeckIssue] = []
	/// Review only.
	public var pr: DeckPR?

	public init(mode: Mode, cwd: String) {
		self.mode = mode
		self.cwd = cwd
	}

	var json: [String: Any] {
		var body: [String: Any] = ["mode": mode.rawValue, "cwd": cwd]
		let optional: [(String, String?)] = [
			("prompt", prompt), ("kind", kind), ("model", model), ("provider", provider),
			("effort", effort), ("permissionMode", permissionMode)
		]
		for (key, value) in optional { if let value { body[key] = value } }
		switch mode {
		case .work:
			if let title { body["title"] = title }
			if let worktree { body["worktree"] = worktree.json }
			if let first = issues.first { body["issue"] = Self.fields(first) }
			if issues.count > 1 { body["issues"] = issues.map(Self.fields) }
		case .review:
			if let pr {
				var prBody: [String: Any] = ["repo": pr.repo, "number": pr.number]
				if let url = pr.url { prBody["url"] = url }
				if let title = pr.title { prBody["title"] = title }
				body["pr"] = prBody
				if let base = pr.baseRefName { body["worktree"] = ["base": base] }
			}
		}
		return body
	}

	private static func fields(_ issue: DeckIssue) -> [String: Any] {
		var result: [String: Any] = ["source": issue.source, "id": issue.issueId]
		if let url = issue.url { result["url"] = url }
		if let sourceId = issue.sourceId { result["sourceId"] = sourceId }
		return result
	}
}

/// A start turned into one create per session, the way the web's new-session
/// modal fans out: one review per PR, and one work session per issue when
/// split, else one combined session.
///
/// Each item keeps its idempotency key for the life of the plan, so a retry
/// re-sends only the creates that did not land, under the same keys. deck
/// evicts a key whose create failed, so a failed item really runs again; one
/// whose response was lost replays the session it already made.
public struct StartPlan: Equatable, Sendable {
	public enum Status: Equatable, Sendable {
		case pending
		case running
		case created(id: String)
		case failed(String)
		case conflict(WorktreeConflict)
	}

	public struct Item: Identifiable, Equatable, Sendable {
		/// The selection this came from (an issue or PR id, or "combined").
		public let id: String
		public let label: String
		public var request: CreateSessionRequest
		public let idempotencyKey: String
		public var status: Status = .pending

		public init(id: String, label: String, request: CreateSessionRequest, idempotencyKey: String) {
			self.id = id
			self.label = label
			self.request = request
			self.idempotencyKey = idempotencyKey
		}

		public var isCreated: Bool {
			if case .created = status { return true }
			return false
		}
	}

	public private(set) var items: [Item]

	public init(items: [Item]) {
		self.items = items
	}

	/// Splitting needs a fresh worktree per issue: every split session in one
	/// existing directory (or the project itself) would step on the others.
	public static func canSplit(issueCount: Int, worktree: WorktreeOptions?) -> Bool {
		issueCount > 1 && worktree?.newBranch == true
	}

	/// Work: one session on every issue, or with `split` one per issue, each
	/// on a branch named after its issue and titled with its short id.
	public static func work(
		_ base: CreateSessionRequest,
		issues: [DeckIssue],
		split: Bool,
		makeKey: () -> String = { UUID().uuidString }
	) -> StartPlan {
		guard split, canSplit(issueCount: issues.count, worktree: base.worktree) else {
			var request = base
			request.issues = issues
			return StartPlan(items: [Item(id: "combined", label: base.title ?? "session", request: request, idempotencyKey: makeKey())])
		}
		return StartPlan(items: issues.map { issue in
			var request = base
			request.issues = [issue]
			request.title = issue.shortId
			request.worktree = WorktreeOptions(branch: issue.issueId, newBranch: true, base: base.worktree?.base)
			return Item(id: issue.id, label: issue.shortId, request: request, idempotencyKey: makeKey())
		})
	}

	/// Review: one session per PR (there is no multi-PR worktree).
	public static func review(
		_ base: CreateSessionRequest,
		prs: [DeckPR],
		makeKey: () -> String = { UUID().uuidString }
	) -> StartPlan {
		StartPlan(items: prs.map { pr in
			var request = base
			request.pr = pr
			return Item(id: pr.id, label: "#\(pr.number)", request: request, idempotencyKey: makeKey())
		})
	}

	/// `fresh` (rebuilt from the form as it is now) with this plan's history:
	/// an item already created stays created and is not sent again, and every
	/// other item keeps its key, so a create whose response was lost replays
	/// rather than making a second session.
	public func carrying(into fresh: StartPlan) -> StartPlan {
		let old = Dictionary(items.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
		return StartPlan(items: fresh.items.map { item in
			guard let prior = old[item.id] else { return item }
			var carried = Item(id: item.id, label: item.label, request: item.request, idempotencyKey: prior.idempotencyKey)
			if prior.isCreated { carried.status = prior.status }
			return carried
		})
	}

	/// Mark everything not yet created as running and return it to send.
	public mutating func begin() -> [Item] {
		var batch: [Item] = []
		for index in items.indices where !items[index].isCreated {
			items[index].status = .running
			batch.append(items[index])
		}
		return batch
	}

	/// Record how one create went. An `onExisting` answer is spent on the
	/// attempt it rode on, as on the web: a later retry asks again rather than
	/// deleting a branch on a choice made for an earlier failure.
	public mutating func record(_ id: String, _ status: Status) {
		guard let index = items.firstIndex(where: { $0.id == id }) else { return }
		items[index].status = status
		items[index].request.worktree?.onExisting = nil
	}

	/// Answer every conflicted item with `fix` and make it pending again.
	public mutating func resolveConflicts(with fix: WorktreeFix) {
		for index in items.indices {
			guard case .conflict = items[index].status else { continue }
			items[index].request.worktree?.onExisting = fix
			items[index].status = .pending
		}
	}

	public static func status(for error: Error) -> Status {
		if case DeckError.worktreeConflict(let conflict) = error { return .conflict(conflict) }
		return .failed(error.localizedDescription)
	}

	public var conflicts: [WorktreeConflict] {
		items.compactMap { item in
			if case .conflict(let conflict) = item.status { return conflict }
			return nil
		}
	}

	public var failures: [(label: String, message: String)] {
		items.compactMap { item in
			if case .failed(let message) = item.status { return (item.label, message) }
			return nil
		}
	}

	public var createdIds: [String] {
		items.compactMap { item in
			if case .created(let id) = item.status { return id }
			return nil
		}
	}

	public var isFinished: Bool { !items.isEmpty && items.allSatisfy(\.isCreated) }
}
