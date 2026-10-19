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
	@State private var query = ""
	@State private var deepLinkRunId: String?
	@State private var showPalette = false
	@State private var picked: PaletteItem?
	@State private var showReviews = false
	@FocusState private var searchFocused: Bool

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
			nextSession: { step(1) }))
		.sheet(isPresented: $showPalette, onDismiss: runPicked) {
			CommandPaletteView(index: paletteIndex) { picked = $0 }
				.frame(minWidth: 520, minHeight: 420)
		}
		.onReceive(NotificationCenter.default.publisher(for: .deckOpenSession)) { note in
			if let id = note.object as? String { selection = .session(id) }
		}
		.onReceive(NotificationCenter.default.publisher(for: .deckOpenRun)) { note in
			guard let id = note.object as? String else { return }
			deepLinkRunId = id
			selection = .inbox
		}
		.macOpenTarget(selection: $selection)
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
			StartView { selection = .session($0) }
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
		return q.isEmpty ? store.activeSessions : SessionSearch.byName(q, in: store.activeSessions)
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

/// The sidebar: places, then the sessions, then the hidden ones. A
/// double-click (or "Open in New Window") gives a session a window of its own.
private struct MacSidebar: View {
	@Environment(DeckStore.self) private var store
	@Environment(\.openWindow) private var openWindow
	@Binding var selection: MacPane?
	@Binding var query: String
	let listed: [SessionDigest]

	private var isFiltering: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }

	var body: some View {
		List(selection: $selection) {
			if store.serverTooOld {
				ServerTooOldBanner()
			}
			PairingBanner()
			Section {
				Label("Inbox", systemImage: "tray")
					.badge(store.awaitingCount)
					.tag(MacPane.inbox)
				Label("Runs", systemImage: "point.3.connected.trianglepath.dotted")
					.badge(store.runs.filter { !$0.status.isFinished }.count)
					.tag(MacPane.runs)
				Label("Schedules", systemImage: "clock.arrow.2.circlepath").tag(MacPane.schedules)
				Label("Start", systemImage: "plus.circle").tag(MacPane.start)
			}
			Section("Sessions") {
				ForEach(listed) { session in
					SessionRow(session: session).tag(MacPane.session(session.id))
				}
			}
			if !isFiltering, !store.hiddenSessions.isEmpty {
				Section("Hidden") {
					ForEach(store.hiddenSessions) { session in
						SessionRow(session: session).tag(MacPane.session(session.id))
					}
				}
			}
		}
		.contextMenu(forSelectionType: MacPane.self) { panes in
			if let id = panes.first?.sessionId, panes.count == 1 {
				sessionMenu(id)
			}
		} primaryAction: { panes in
			for id in panes.compactMap(\.sessionId) { openWindow(id: MacWindow.session, value: id) }
		}
		.overlay {
			if store.sessions.isEmpty, store.connection == .live {
				ContentUnavailableView("No sessions", systemImage: "tray")
			}
		}
		.safeAreaInset(edge: .bottom) { MacConnectionStatus() }
		.navigationTitle("deck")
		.toolbar {
			ToolbarItem {
				Button {
					Task { await store.refreshSessions() }
				} label: {
					Label("Refresh", systemImage: "arrow.clockwise")
				}
			}
		}
	}

	@ViewBuilder
	private func sessionMenu(_ id: String) -> some View {
		Button("Open in New Window") { openWindow(id: MacWindow.session, value: id) }
		let hidden = store.hiddenSessions.contains { $0.id == id }
		Button(hidden ? "Unhide" : "Hide") {
			Task { try? await store.setHidden(sessionId: id, hidden: !hidden) }
		}
	}
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
