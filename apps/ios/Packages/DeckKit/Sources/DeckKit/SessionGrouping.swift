import Foundation

/// How the session list is cut up. Mirrors deck's `bucketSessions`
/// (`status-groups.ts`) and `groupSessions` (`groups.ts`). Callers pass the
/// sessions they want listed, so hidden ones are filtered out first.
public enum SessionGrouping {
	public enum Mode: String, CaseIterable, Sendable {
		case project, status

		public var toggled: Mode { self == .project ? .status : .project }

		/// Names the mode you would switch to.
		public var toggleLabel: String { self == .project ? "Group by status" : "Group by project" }
	}

	/// The `@AppStorage` key the apps keep the mode under.
	public static let storageKey = "sessionGrouping"

	// MARK: - By status

	public enum Bucket: String, CaseIterable, Sendable {
		case unread, needsAttention = "needs-attention", active, justFinished = "just-finished", idle, dead

		public var label: String {
			switch self {
			case .unread: "Unread"
			case .needsAttention: "Needs attention"
			case .active: "Active"
			case .justFinished: "Just finished"
			case .idle: "Idle"
			case .dead: "Dead"
			}
		}
	}

	public struct StatusSection: Identifiable, Sendable {
		public var id: Bucket { bucket }
		public let bucket: Bucket
		public let sessions: [SessionDigest]
	}

	/// An idle session counts as just finished within this window.
	public static let justFinishedWindow: TimeInterval = 15 * 60

	/// Fixed bucket order, newest first within each, empty buckets dropped.
	public static func byStatus(_ sessions: [SessionDigest], now: Date = Date()) -> [StatusSection] {
		let nowMs = now.timeIntervalSince1970 * 1000
		let buckets = Dictionary(grouping: sessions) { bucket(of: $0, nowMs: nowMs) }
		return Bucket.allCases.compactMap { bucket in
			buckets[bucket].map { StatusSection(bucket: bucket, sessions: recentFirst($0)) }
		}
	}

	private static func bucket(of s: SessionDigest, nowMs: Double) -> Bucket {
		if s.status == .error || s.awaitingInput == true { return .needsAttention }
		if s.unread == true { return .unread }
		switch s.status {
		case .running: return .active
		case .dead: return .dead
		default: return nowMs - (s.lastActiveAt ?? 0) <= justFinishedWindow * 1000 ? .justFinished : .idle
		}
	}

	private static func recentFirst(_ list: [SessionDigest]) -> [SessionDigest] {
		list.sorted { ($0.lastActiveAt ?? 0) > ($1.lastActiveAt ?? 0) }
	}

	// MARK: - By project

	/// The bucket for a project with no group, and for unregistered directories.
	public static let ungrouped = "Ungrouped"

	public struct ProjectSubgroup: Identifiable, Sendable {
		public var id: String { key }
		public let key: String
		public let label: String
		public let sessions: [SessionDigest]
	}

	public struct ProjectSection: Identifiable, Sendable {
		public var id: String { name }
		public let name: String
		public let subgroups: [ProjectSubgroup]
	}

	/// Sessions cluster into per-project subgroups (most recently active first),
	/// which cluster into the project's group. Groups sort alphabetically with
	/// Ungrouped last.
	public static func byProject(_ sessions: [SessionDigest], projects: [DeckProject]) -> [ProjectSection] {
		struct Draft {
			var key: String
			var label: String
			var sessions: [SessionDigest] = []
			var group: String
			var lastActiveAt = 0.0
		}
		var drafts: [String: Draft] = [:]
		for s in sessions {
			let owner = SessionProject.owning(s, in: projects)
			let key = owner?.path ?? unregisteredPath(s.cwd)
			var d = drafts[key] ?? Draft(
				key: key,
				label: owner?.name ?? shortPath(key),
				group: owner?.group?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty ?? ungrouped
			)
			d.sessions.append(s)
			d.lastActiveAt = max(d.lastActiveAt, s.lastActiveAt ?? 0)
			drafts[key] = d
		}
		return Dictionary(grouping: drafts.values, by: \.group)
			.map { name, group in
				ProjectSection(
					name: name,
					subgroups: group.sorted { $0.lastActiveAt != $1.lastActiveAt ? $0.lastActiveAt > $1.lastActiveAt : $0.key < $1.key }
						.map { ProjectSubgroup(key: $0.key, label: $0.label, sessions: $0.sessions.filter { $0.unread == true } + $0.sessions.filter { $0.unread != true }) })
			}
			.sorted { a, b in
				let rank = { (n: String) in n == ungrouped ? 1 : 0 }
				return rank(a.name) == rank(b.name) ? a.name.localizedCompare(b.name) == .orderedAscending : rank(a.name) < rank(b.name)
			}
	}

	/// The sessions in the order the grouped list shows them, for stepping
	/// through it from the keyboard.
	public static func ordered(_ sessions: [SessionDigest], by mode: Mode, projects: [DeckProject], now: Date = Date()) -> [SessionDigest] {
		switch mode {
		case .status: byStatus(sessions, now: now).flatMap(\.sessions)
		case .project: byProject(sessions, projects: projects).flatMap { $0.subgroups.flatMap(\.sessions) }
		}
	}

	private static func unregisteredPath(_ cwd: String?) -> String {
		guard let cwd, !cwd.isEmpty else { return "" }
		return cwd.range(of: "-worktrees/").map { String(cwd[..<$0.lowerBound]) } ?? cwd
	}

	/// Collapses a home directory to "~" (macOS, Linux, root).
	static func shortPath(_ path: String) -> String {
		path.replacingOccurrences(
			of: #"^(/Users/[^/]+|/home/[^/]+|/root)(?=/|$)"#, with: "~", options: .regularExpression)
	}
}

private extension String {
	var nilIfEmpty: String? { isEmpty ? nil : self }
}
