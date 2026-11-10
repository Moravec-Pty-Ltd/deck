import SwiftUI
import DeckKit
import DeckUI

/// What the main window's sidebar can show.
enum MacPane: Hashable {
	case inbox, runs, schedules, start
	case session(String)

	var sessionId: String? {
		if case .session(let id) = self { return id }
		return nil
	}
}

/// The main window: a sidebar of places (Inbox, Runs, Schedules, Start) over
/// the sessions list, and whichever of them is selected beside it.
struct MacMainView: View {
	@Environment(DeckStore.self) private var store
	@Environment(\.openWindow) private var openWindow
	@Environment(\.openSettings) private var openSettings
	@State private var selection: MacPane? = .inbox
	/// The session this window showed before Start, which Start defaults to.
	@State private var lastSessionId: String?
	@AppStorage(SessionGrouping.storageKey) private var grouping: SessionGrouping.Mode = .project
	@PickedGroup private var pickedGroup
	@State private var query = ""
	@State private var deepLinkRunId: String?
	@State private var showPalette = false
	@State private var picked: PaletteItem?
	@State private var showReviews = false
	@FocusState private var searchFocused: Bool
	@Environment(\.opensHere) private var opensHere

	var body: some View {
		NavigationSplitView {
			MacSidebar(selection: $selection, query: $query, listed: listedSessions)
				.searchable(text: $query, placement: .sidebar, prompt: "Search sessions")
				.searchFocused($searchFocused)
				.navigationSplitViewColumnWidth(min: 240, ideal: 300)
				.toolbar {
					ToolbarItem {
						Button {
							showReviews = true
						} label: {
							Label("Reviews", systemImage: "checklist")
						}
						.help("PR reviews")
					}
				}
		} detail: {
			detail
		}
		.focusedSceneValue(\.deckScene, DeckSceneActions(
			openPalette: { showPalette = true },
			newSession: { selection = .start },
			focusSearch: { searchFocused = true },
			previousSession: { step(-1) },
			nextSession: { step(1) },
			groups: store.groupEntries,
			pickGroup: { pickedGroup = $0 }))
		.followsGroup(ofSession: selection?.sessionId)
		.sheet(isPresented: $showPalette, onDismiss: runPicked) {
			CommandPaletteView(index: paletteIndex) { picked = $0 }
				.frame(minWidth: 520, minHeight: 420)
		}
		.onChange(of: store.badgeCount, initial: true) { _, count in if let count { AskNotification.setBadge(count) } }
		.onChange(of: selection) { _, pane in
			if pane != .start { lastSessionId = pane?.sessionId }
		}
		.onReceive(NotificationCenter.default.publisher(for: .deckOpenSession)) { note in
			if opensHere(note), let id = note.object as? String { selection = .session(id) }
		}
		.onReceive(NotificationCenter.default.publisher(for: .deckOpenRun)) { note in
			guard opensHere(note), let id = note.object as? String else { return }
			deepLinkRunId = id
			selection = .inbox
		}
		.sheet(isPresented: $showReviews) {
			ReviewsView { selection = .session($0) }
				.frame(minWidth: 520, minHeight: 480)
		}
	}

	@ViewBuilder
	private var detail: some View {
		switch selection {
		case .inbox:
			InboxView(deepLinkRunId: $deepLinkRunId)
		case .runs:
			MacRunsView()
		case .schedules:
			NavigationStack { SchedulesView() }
		case .start:
			StartView(openSessionId: lastSessionId ?? MacFrontSession.id) { selection = .session($0) }
		case .session(let id):
			NavigationStack {
				MacSessionDetail(sessionId: id, onIdChanged: { selection = .session($0) }, onDeleted: { selection = nil })
			}
			.id(id)
		case nil:
			ContentUnavailableView("Nothing selected", systemImage: "sidebar.left")
		}
	}

	/// The sessions the sidebar lists, in its order: what ⌘[ and ⌘] step through.
	private var listedSessions: [SessionDigest] {
		let q = query.trimmingCharacters(in: .whitespaces)
		let active = store.activeSessions(inGroup: store.selectedGroup(picked: pickedGroup))
		return q.isEmpty
			? SessionGrouping.ordered(active, by: grouping, projects: store.projects)
			: SessionSearch.byName(q, in: active)
	}

	private func step(_ offset: Int) {
		let ids = listedSessions.map(\.id)
		if let next = SessionStepper.step(from: selection?.sessionId, by: offset, in: ids) {
			selection = .session(next)
		}
	}

	private var paletteIndex: PaletteIndex {
		var actions: [PaletteAction] = [.newSession, .searchSessions]
		if let id = selection?.sessionId, store.sessions.first(where: { $0.id == id })?.status == .running {
			actions.append(.stopTurn)
		}
		actions += [.previousSession, .nextSession, .inbox, .macRuns, .macSchedules, .voiceOperator, .browser, .settings]
		actions += GroupSwitch.paletteActions(store.groupEntries, selected: store.selectedGroup(picked: pickedGroup))
		return PaletteIndex(actions: actions, sessions: store.activeSessions)
	}

	private func runPicked() {
		guard let item = picked else { return }
		picked = nil
		switch item {
		case .session(let session): selection = .session(session.id)
		case .action(let action): perform(action)
		}
	}

	private func perform(_ action: PaletteAction) {
		switch action.id {
		case _ where GroupSwitch.storedValue(for: action) != nil:
			pickedGroup = GroupSwitch.storedValue(for: action) ?? ""
		case PaletteAction.newSession.id: selection = .start
		case PaletteAction.searchSessions.id: searchFocused = true
		case PaletteAction.previousSession.id: step(-1)
		case PaletteAction.nextSession.id: step(1)
		case PaletteAction.inbox.id: selection = .inbox
		case PaletteAction.macRuns.id: selection = .runs
		case PaletteAction.macSchedules.id: selection = .schedules
		case PaletteAction.voiceOperator.id: openWindow(id: "operator")
		case PaletteAction.browser.id: openWindow(id: "browser")
		case PaletteAction.settings.id: openSettings()
		case PaletteAction.stopTurn.id:
			guard let id = selection?.sessionId else { return }
			Task { try? await store.stop(sessionId: id) }
		default: break
		}
	}
}

extension PaletteAction {
	/// Places only the Mac's sidebar has; the phone keeps runs in the inbox
	/// and schedules under Start.
	static let macRuns = PaletteAction(
		id: "runs", title: "Runs", keywords: ["workflow", "board", "phases"], systemImage: "point.3.connected.trianglepath.dotted")
	static let macSchedules = PaletteAction(
		id: "schedules", title: "Schedules", keywords: ["cron", "repeat", "clock"], systemImage: "clock.arrow.2.circlepath")
}

/// The sidebar: pinned places over the scrolling sessions and hidden ones. A
/// double-click (or "Open in New Window") gives a session a window of its own.
private struct MacSidebar: View {
	@Environment(DeckStore.self) private var store
	@Environment(\.openWindow) private var openWindow
	@Binding var selection: MacPane?
	@Binding var query: String
	let listed: [SessionDigest]
	@AppStorage(SessionGrouping.storageKey) private var grouping: SessionGrouping.Mode = .project
	@PickedGroup private var pickedGroup
	@State private var placesHeight: CGFloat = 120
	@FocusState private var focus: SidebarList?
	@State private var pendingDelete: SidebarDelete?
	@State private var renaming: SidebarRename?
	@State private var compacting: Set<String> = []
	@State private var actionError: String?
	/// The sessions list's own selection, so ⌘- and ⇧-click can pick several
	/// for the batch menu; one picked session drives the shared `selection`.
	@State private var picked: Set<MacPane> = []

	private enum SidebarList { case places, sessions }

	private var focusGroup: String? { store.selectedGroup(picked: pickedGroup) }

	private var hidden: [SessionDigest] { store.hiddenSessions(inGroup: focusGroup) }

	/// The session row the arrow keys reach from Start, and leave for it.
	private var firstSession: String? {
		listed.first?.id ?? (isFiltering ? nil : hidden.first?.id)
	}

	private var isFiltering: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }

	var body: some View {
		VStack(spacing: 0) {
			if !store.groupEntries.isEmpty {
				GroupSwitcher()
					.menuStyle(.borderlessButton)
					.fixedSize()
					.frame(maxWidth: .infinity, alignment: .leading)
					.padding(.horizontal, 12)
					.padding(.vertical, 6)
			}
			places
			Divider()
			sessions
		}
		.navigationTitle("deck")
		.toolbar {
			ToolbarItem {
				Button {
					grouping = grouping.toggled
				} label: {
					Label(grouping.toggleLabel, systemImage: "rectangle.3.group")
				}
				.help(grouping.toggleLabel)
			}
			ToolbarItem {
				Button {
					Task { await store.refreshSessions() }
				} label: {
					Label("Refresh", systemImage: "arrow.clockwise")
				}
			}
		}
	}

	/// The places stay put above the scrolling sessions: a list of their own,
	/// sharing the selection, sized to its rows so it never scrolls.
	private var places: some View {
		List(selection: $selection) {
			Label("Inbox", systemImage: "tray")
				.badge(store.awaitingCount)
				.tag(MacPane.inbox)
			Label("Runs", systemImage: "point.3.connected.trianglepath.dotted")
				.badge(store.board(inGroup: focusGroup).filter { !$0.status.isFinished }.count)
				.tag(MacPane.runs)
			Label("Schedules", systemImage: "clock.arrow.2.circlepath").tag(MacPane.schedules)
			Label("Start", systemImage: "plus.circle").tag(MacPane.start)
		}
		.scrollDisabled(true)
		.onScrollGeometryChange(for: CGFloat.self) {
			$0.contentSize.height + $0.contentInsets.top + $0.contentInsets.bottom
		} action: { placesHeight = $1 }
		.frame(height: placesHeight)
		.focused($focus, equals: .places)
		// Two lists, so the arrow keys are carried across the seam by hand.
		.onKeyPress(.downArrow) {
			guard selection == .start, let id = firstSession else { return .ignored }
			selection = .session(id)
			focus = .sessions
			return .handled
		}
	}

	private var sessions: some View {
		List(selection: $picked) {
			if store.serverTooOld {
				ServerTooOldBanner()
			}
			PairingBanner()
			if isFiltering {
				Section("Sessions") {
					ForEach(listed) { row($0) }
					if listed.isEmpty, focusGroup != nil {
						Button("All groups") { pickedGroup = "" }
					}
				}
			} else if grouping == .status {
				ForEach(SessionGrouping.byStatus(store.activeSessions(inGroup: focusGroup))) { section in
					Section {
						ForEach(section.sessions) { row($0) }
					} header: {
						StatusBucketHeader(bucket: section.bucket, unreadIds: section.sessions.map(\.id))
					}
				}
			} else {
				ForEach(SessionGrouping.byProject(store.activeSessions(inGroup: focusGroup), projects: store.projects)) { section in
					Section(section.name) {
						ForEach(section.subgroups) { subgroup in
							Text(subgroup.label)
								.font(.caption)
								.foregroundStyle(.secondary)
							ForEach(subgroup.sessions) { row($0) }
						}
					}
				}
			}
			if !isFiltering, !hidden.isEmpty {
				Section("Hidden") {
					ForEach(hidden) { row($0) }
				}
			}
		}
		.contextMenu(forSelectionType: MacPane.self) { panes in
			let ids = panes.compactMap(\.sessionId)
			if ids.count == 1, let id = ids.first {
				sessionMenu(id)
			} else if ids.count > 1 {
				batchMenu(ids)
			}
		} primaryAction: { panes in
			for id in panes.compactMap(\.sessionId) { openWindow(id: MacWindow.session, value: id) }
		}
		.overlay {
			if store.sessions.isEmpty, store.connection == .live {
				ContentUnavailableView("No sessions", systemImage: "tray")
			} else if let focusGroup, !isFiltering, listed.isEmpty, hidden.isEmpty {
				ContentUnavailableView("No sessions in \(focusGroup)", systemImage: "tray")
			}
		}
		.safeAreaInset(edge: .bottom) { MacConnectionStatus() }
		.sheet(item: $pendingDelete) { request in
			// Live state, so a session that starts a turn while this is open still warns.
			let live = request.ids.compactMap { id in store.sessions.first { $0.id == id } }
			DeleteSessionSheet(
				hasWorktree: live.contains { $0.worktree != nil },
				count: live.count,
				name: request.name,
				sessions: live
			) { deleteWorktree, deleteBranch in
				Task { await delete(live.map(\.id), worktree: deleteWorktree, branch: deleteBranch) }
			}
		}
		.sheet(item: $renaming) { target in
			RenameSessionSheet(current: target.title) { newTitle in
				do {
					let id = try await store.rename(sessionId: target.id, title: newTitle)
					if id != target.id, selection?.sessionId == target.id { selection = .session(id) }
					return nil
				} catch {
					return error.localizedDescription
				}
			}
		}
		.alert("Something went wrong", isPresented: Binding(
			get: { actionError != nil },
			set: { if !$0 { actionError = nil } })
		) {
			Button("OK", role: .cancel) {}
		} message: {
			Text(actionError ?? "")
		}
		.focused($focus, equals: .sessions)
		.onChange(of: picked) { _, panes in
			if panes.count == 1, let pane = panes.first, pane != selection { selection = pane }
		}
		.onChange(of: selection, initial: true) { _, pane in
			if pane?.sessionId == nil {
				picked = []
			} else if let pane, picked != [pane] {
				picked = [pane]
			}
		}
		.onKeyPress(.upArrow) {
			guard picked.count <= 1, let id = selection?.sessionId, id == firstSession else { return .ignored }
			selection = .start
			focus = .places
			return .handled
		}
	}

	private func row(_ session: SessionDigest) -> some View {
		SessionRow(session: session).tag(MacPane.session(session.id))
	}

	/// Open, rename and hide; then compact and the PR; delete last.
	@ViewBuilder
	private func sessionMenu(_ id: String) -> some View {
		let session = store.sessions.first { $0.id == id }
		let title = SessionDetailViewModel.title(of: session, id: id)
		Button("Open in New Window") { openWindow(id: MacWindow.session, value: id) }
		Button("Rename…") { renaming = SidebarRename(id: id, title: title) }
		let hidden = session?.hidden == true
		Button(hidden ? "Unhide" : "Hide") {
			run { try await store.setHidden(sessionId: id, hidden: !hidden) }
		}
		let context = session?.kind == "claude" ? session?.context : nil
		let canDismissPR = session?.pr != nil && store.supports(.prDismiss)
		if context != nil || canDismissPR { Divider() }
		if let context {
			Button("Compact Context (\(context.percent)%)") { compact(id) }
				.disabled(session?.status == .running || compacting.contains(id))
		}
		if canDismissPR {
			Button("Dismiss PR") { run { try await store.dismissPR(sessionId: id) } }
		}
		Divider()
		Button("Delete Session…", role: .destructive) { pendingDelete = SidebarDelete(ids: [id], name: title) }
	}

	@ViewBuilder
	private func batchMenu(_ ids: [String]) -> some View {
		let allHidden = ids.allSatisfy { id in store.sessions.first { $0.id == id }?.hidden == true }
		Button(allHidden ? "Unhide" : "Hide") {
			run { for id in ids { try await store.setHidden(sessionId: id, hidden: !allHidden) } }
		}
		Divider()
		Button("Delete \(ids.count) Sessions…", role: .destructive) { pendingDelete = SidebarDelete(ids: ids) }
	}

	private func compact(_ id: String) {
		compacting.insert(id)
		run {
			defer { compacting.remove(id) }
			try await store.compact(sessionId: id)
		}
	}

	private func run(_ action: @escaping () async throws -> Void) {
		Task {
			do { try await action() } catch { report(error) }
		}
	}

	/// Deletes through the store, then lets go of whatever showed a deleted
	/// session: the detail pane, and any window of its own.
	private func delete(_ ids: [String], worktree: Bool, branch: Bool) async {
		do {
			let failures = try await store.deleteSessions(sessionIds: ids, deleteWorktree: worktree, deleteBranch: branch)
			for id in ids where failures[id] == nil {
				if selection?.sessionId == id { selection = nil }
				picked.remove(.session(id))
				NotificationCenter.default.post(name: .deckSessionDeleted, object: id)
			}
			if let first = failures.values.sorted().first {
				actionError = failures.count == 1 ? first : "\(failures.count) of \(ids.count) sessions couldn't be deleted. \(first)"
			}
		} catch {
			report(error)
		}
	}

	/// As the session window's: a cancelled request is not worth an alert.
	private func report(_ error: Error) {
		if error is CancellationError { return }
		let nsError = error as NSError
		if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
		actionError = error.localizedDescription
	}
}

private struct SidebarDelete: Identifiable {
	let id = UUID()
	let ids: [String]
	var name: String?
}

private struct SidebarRename: Identifiable {
	let id: String
	let title: String
}

extension Notification.Name {
	/// A session the main window deleted, so its own window closes too.
	static let deckSessionDeleted = Notification.Name("deck.sessionDeleted")
}

/// The connection line under the sidebar, shown only when it is not live.
struct MacConnectionStatus: View {
	@Environment(DeckStore.self) private var store

	var body: some View {
		switch store.connection {
		case .offline(let reason):
			Label(reason, systemImage: "wifi.exclamationmark")
				.font(.caption)
				.foregroundStyle(.orange)
				.frame(maxWidth: .infinity, alignment: .leading)
				.padding(8)
		case .connecting:
			HStack(spacing: 6) {
				ProgressView().controlSize(.small)
				Text("Connecting").font(.caption).foregroundStyle(.secondary)
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			.padding(8)
		case .live, .signedOut:
			EmptyView()
		}
	}
}
