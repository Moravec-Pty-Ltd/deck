import Foundation

/// Focusing the app on one project group. Mirrors the switcher logic in deck's
/// `src/lib/groups.ts`; a change there changes here, and `GroupSwitchTests`
/// follows the same cases as `groups.test.ts`. It always names the no-group
/// bucket "Ungrouped", as the session list does; `ProjectGroups` calls that bucket
/// "Projects", and `pickerGroups` is where the two meet.
public enum GroupSwitch {
	/// The `@AppStorage` key the apps keep the pick under. Empty means All, so a
	/// project group can be called anything.
	public static let storageKey = "sessionGroup"

	public static let otherGroups = "Other groups"

	private static let paletteIdPrefix = "group:"

	/// One line in the switcher. `name` is nil for All; `count` is how many of
	/// its sessions need you.
	public struct Entry: Identifiable, Hashable, Sendable {
		public let name: String?
		public let label: String
		public let count: Int

		public var id: String { storedValue }
		/// What `storageKey` holds when this line is picked.
		public var storedValue: String { name ?? "" }
		/// A menu row's text: a menu has no room of its own for a badge.
		public var menuTitle: String { count > 0 ? "\(label) (\(count))" : label }
	}

	/// The group a project lists under.
	public static func group(of project: DeckProject?) -> String {
		let name = project?.group?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
		return name.isEmpty ? SessionGrouping.ungrouped : name
	}

	public static func group(of session: SessionDigest, in projects: [DeckProject]) -> String {
		group(of: SessionProject.owning(session, in: projects))
	}

	public static func group(ofPath path: String, in projects: [DeckProject]) -> String {
		group(of: SessionProject.owning(path: path, in: projects))
	}

	/// What the switcher lists: All, each group, then Ungrouped when a project or
	/// a session lands there (an adhoc shell's question must have somewhere to
	/// show). Empty when no project has a group: nothing to switch between.
	public static func entries(_ sessions: [SessionDigest], projects: [DeckProject]) -> [Entry] {
		let names = Set(projects.map { group(of: $0) }).subtracting([SessionGrouping.ungrouped])
			.sorted { $0.localizedCompare($1) == .orderedAscending }
		guard !names.isEmpty else { return [] }
		var counts: [String: Int] = [:]
		var total = 0
		var hasUngrouped = projects.contains { group(of: $0) == SessionGrouping.ungrouped }
		for session in sessions {
			let name = group(of: session, in: projects)
			if name == SessionGrouping.ungrouped { hasUngrouped = true }
			guard session.hidden != true, session.awaitingInput == true || session.unread == true else { continue }
			counts[name, default: 0] += 1
			total += 1
		}
		return [Entry(name: nil, label: "All", count: total)]
			+ (names + (hasUngrouped ? [SessionGrouping.ungrouped] : []))
			.map { Entry(name: $0, label: $0, count: counts[$0] ?? 0) }
	}

	/// The selection in force: what was picked while it still exists, else All.
	public static func resolved(picked: String, in entries: [Entry]) -> String? {
		entries.first { $0.storedValue == picked }?.name
	}

	/// Whether a group other than the selected one has something waiting. All
	/// shows everything, so nothing is ever elsewhere.
	public static func waitingElsewhere(_ entries: [Entry], selected: String?) -> Bool {
		guard let selected else { return false }
		return entries.contains { $0.name != nil && $0.name != selected && $0.count > 0 }
	}

	public static func sessions(_ list: [SessionDigest], in selected: String?, projects: [DeckProject]) -> [SessionDigest] {
		guard let selected else { return list }
		return list.filter { group(of: $0, in: projects) == selected }
	}

	public static func runs(_ list: [RunDigest], in selected: String?, projects: [DeckProject]) -> [RunDigest] {
		guard let selected else { return list }
		return list.filter { group(ofPath: $0.projectPath, in: projects) == selected }
	}

	/// A schedule belongs where it runs: its directory, or its target session's.
	/// One whose session has gone counts as Ungrouped, like an adhoc shell.
	public static func schedules(
		_ list: [DeckSchedule], in selected: String?, sessions: [SessionDigest], projects: [DeckProject]
	) -> [DeckSchedule] {
		guard let selected else { return list }
		return list.filter { schedule in
			if let cwd = schedule.cwd { return group(ofPath: cwd, in: projects) == selected }
			let target = sessions.first { $0.id == schedule.sessionId }
			return target.map { group(of: $0, in: projects) } ?? SessionGrouping.ungrouped == selected
		}
	}

	/// The selection after opening a session: one in another group brings its
	/// group along, so it isn't left open but missing from the list.
	public static func afterOpening(_ session: SessionDigest, projects: [DeckProject], selected: String?) -> String? {
		selected == nil ? nil : group(of: session, in: projects)
	}

	/// Start's project menu with a group selected: that group first, the rest
	/// under "Other groups", Hidden still last.
	public static func pickerGroups(_ projects: [DeckProject], selected: String?) -> [ProjectGroups.Group] {
		let all = ProjectGroups.grouped(projects)
		guard let selected else { return all }
		let key = selected == SessionGrouping.ungrouped ? ProjectGroups.ungrouped : selected
		let others = all
			.filter { $0.name != key && $0.name != ProjectGroups.hidden }
			.flatMap(\.projects)
			.sorted { $0.name < $1.name }
		return all.filter { $0.name == key }.map { ProjectGroups.Group(name: selected, projects: $0.projects) }
			+ (others.isEmpty ? [] : [ProjectGroups.Group(name: otherGroups, projects: others)])
			+ all.filter { $0.name == ProjectGroups.hidden }
	}

	/// "Switch to <group>" for the palette, leaving out the current one.
	public static func paletteActions(_ entries: [Entry], selected: String?) -> [PaletteAction] {
		entries.enumerated().compactMap { index, entry in
			entry.name == selected ? nil : PaletteAction(
				id: paletteIdPrefix + entry.storedValue,
				title: "Switch to \(entry.label)",
				keywords: ["group", "focus", "workspace"],
				shortcut: index < 9 ? "⌘\(index + 1)" : nil,
				systemImage: "square.stack.3d.up")
		}
	}

	/// The value to store when a palette action came from `paletteActions`.
	public static func storedValue(for action: PaletteAction) -> String? {
		action.id.hasPrefix(paletteIdPrefix) ? String(action.id.dropFirst(paletteIdPrefix.count)) : nil
	}
}

extension DeckStore {
	public var groupEntries: [GroupSwitch.Entry] { GroupSwitch.entries(sessions, projects: projects) }

	public func selectedGroup(picked: String) -> String? { GroupSwitch.resolved(picked: picked, in: groupEntries) }

	public func activeSessions(inGroup group: String?) -> [SessionDigest] {
		GroupSwitch.sessions(activeSessions, in: group, projects: projects)
	}

	public func hiddenSessions(inGroup group: String?) -> [SessionDigest] {
		GroupSwitch.sessions(hiddenSessions, in: group, projects: projects)
	}

	/// The runs board, narrowed to a group.
	public func board(inGroup group: String?) -> [RunDigest] {
		GroupSwitch.runs(board, in: group, projects: projects)
	}
}
