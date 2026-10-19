import SwiftUI
import DeckKit
import DeckUI

/// The list of sessions and the one that is open. On a phone the open session
/// pushes over the list; on an iPad it sits beside it in a split view. On a
/// foldable opened flat the list stays on the left half and the session fills
/// the right, split on the fold, which a NavigationSplitView cannot be pinned
/// to; half open on a table the session takes the whole window (see
/// SessionDetailView), since a column each side of a horizontal fold reads badly.
struct SessionsView: View {
	@Environment(DeckStore.self) private var store
	@Environment(HingeMonitor.self) private var hinge
	@Environment(\.horizontalSizeClass) private var sizeClass
	@Binding var deepLinkSessionId: String?
	/// Opens the Settings tab where there is a sidebar to show it; nil pushes
	/// Settings over the list instead.
	var openSettingsTab: (() -> Void)?
	@State private var open: SessionTarget?
	@State private var path: [SessionTarget] = []
	@State private var models = OpenSessionModel()
	@State private var pendingDelete: DeleteRequest?
	@State private var pendingRename: SessionDigest?
	@State private var deleteError: String?
	@State private var selection = Set<String>()
	@State private var isSelecting = false
	@State private var deleteProgress: DeleteProgress?
	@State private var query = ""
	@State private var hits: [SearchHit] = []
	@State private var searching = false
	@State private var searchTask: Task<Void, Never>?
	/// The Hidden section starts closed: you hid those on purpose.
	@State private var hiddenExpanded = false
	@State private var pushSettings = false
	@State private var columns = NavigationSplitViewVisibility.all
	@State private var showReviews = false

	/// The session that is open, at a message when it came from a search hit.
	struct SessionTarget: Hashable {
		let sessionId: String
		var index: Int? = nil
	}

	private var wide: Bool { sizeClass == .regular && !hinge.isTabletop }

	/// The fold owns the split: half the window each side of the hinge.
	private var foldWidth: CGFloat? { hinge.halfWidth }

	var body: some View {
		Group {
			if wide, let foldWidth {
				HStack(spacing: 0) {
					NavigationStack { sidebar }
						.frame(width: foldWidth)
					Divider()
					NavigationStack { detail }
				}
			} else if wide {
				NavigationSplitView(columnVisibility: $columns) {
					sidebar
						.navigationSplitViewColumnWidth(min: 260, ideal: 360, max: 560)
				} detail: {
					NavigationStack { detail }
				}
				// Balanced keeps the list beside the session in portrait too,
				// rather than sliding it over the session.
				.navigationSplitViewStyle(.balanced)
			} else {
				NavigationStack(path: $path) {
					sidebar.navigationDestination(for: SessionTarget.self) { target in
						session(target)
					}
				}
			}
		}
		.onChange(of: wide, initial: true) { _, wide in
			path = wide ? [] : (open.map { [$0] } ?? [])
		}
		.onChange(of: path) { _, path in
			if !wide { open = path.last }
		}
		.onChange(of: open) { _, open in
			if !wide, path.last != open { path = open.map { [$0] } ?? [] }
			if open == nil { models.close() }
		}
		.onChange(of: deepLinkSessionId) { _, sessionId in
			guard let sessionId else { return }
			open = SessionTarget(sessionId: sessionId)
			deepLinkSessionId = nil
		}
		// A deleted session's detail goes with it.
		.onChange(of: store.sessions.map(\.id)) { _, ids in
			if let open, !ids.contains(open.sessionId) { self.open = nil }
		}
		.onDisappear { models.close() }
	}

	@ViewBuilder
	private var detail: some View {
		if let open {
			session(open)
		} else {
			ContentUnavailableView(
				"No session open",
				systemImage: "bubble.left.and.text.bubble.right",
				description: Text("Pick a session from the list."))
		}
	}

	private func session(_ target: SessionTarget) -> some View {
		SessionDetailView(
			sessionId: target.sessionId,
			focusIndex: target.index,
			shared: models.model(for: target, store: store),
			onIdChanged: { open = SessionTarget(sessionId: $0) }
		)
		.id(target)
	}

	/// A row that opens its session: pushes it on a phone; beside the list it
	/// is a tagged row, so the list's own selection opens it and draws it.
	@ViewBuilder
	private func link<Label: View>(to target: SessionTarget, @ViewBuilder label: () -> Label) -> some View {
		if wide {
			label().tag(target)
		} else {
			NavigationLink(value: target) { label() }
		}
	}

	/// What the list shows: every session, or the ones whose name matches what
	/// is typed. Names lead because most of the time you know which session you
	/// want; what was said still matches, in a section below.
	private var listedSessions: [SessionDigest] {
		matching(store.activeSessions)
	}

	/// The same filter over what is hidden, so typing a name still finds it
	/// without having to unhide it first.
	private var listedHidden: [SessionDigest] {
		matching(store.hiddenSessions)
	}

	private func matching(_ list: [SessionDigest]) -> [SessionDigest] {
		let q = query.trimmingCharacters(in: .whitespaces)
		guard !q.isEmpty else { return list }
		return SessionSearch.byName(q, in: list)
	}

	private var isFiltering: Bool {
		!query.trimmingCharacters(in: .whitespaces).isEmpty
	}

	private func setHidden(_ session: SessionDigest, _ hidden: Bool) {
		Task { try? await store.setHidden(sessionId: session.id, hidden: hidden) }
	}

	/// The projects that hide sessions in the Hidden section, so the section can
	/// offer to bring each one back. A session hidden by its project gets no
	/// unhide of its own: on its own it would stay hidden.
	private var hidingProjects: [DeckProject] {
		let owners = listedHidden.compactMap { SessionProject.owning($0, in: store.projects) }
		var seen = Set<String>()
		return owners.filter { $0.hidden == true && seen.insert($0.path).inserted }
	}

	private var sidebar: some View {
		Group {
			// `sessions`, not `activeSessions`: with everything hidden there is
			// still a Hidden section to reach, so this is not an empty list.
			if store.sessions.isEmpty {
				ContentUnavailableView(
					"No sessions",
					systemImage: "list.bullet.rectangle",
					description: Text("Start a session from the Start tab."))
			} else if isSelecting {
				// Rows do their own selection rather than List(selection:) plus
				// EditMode: that pairing leaves rows in a selectable state and
				// swallows the tap that should open the session.
				List(store.activeSessions) { session in
					Button {
						toggle(session.id)
					} label: {
						HStack(spacing: 12) {
							Image(systemName: selection.contains(session.id)
								? "checkmark.circle.fill" : "circle")
								.font(.title3)
								.foregroundStyle(selection.contains(session.id) ? Color.accentColor : .secondary)
							SessionRow(session: session)
						}
						// A plain button hit-tests only what it draws, so ticking
						// a row would otherwise need a hit on its text.
						.frame(maxWidth: .infinity, alignment: .leading)
						.contentShape(Rectangle())
					}
					.buttonStyle(.plain)
				}
				.listStyle(.plain)
			} else {
				// One List whatever is typed, its contents filtered, rather than
				// swapping to a separate results view: replacing the whole list
				// while the search field is active is what a UIKit list handles
				// worst, and the Mac crashed on it.
				List(selection: wide ? $open : nil) {
					Section {
						ForEach(listedSessions) { session in
							link(to: SessionTarget(sessionId: session.id)) {
								SessionRow(session: session)
							}
							// Deliberately not a destructive-role button, and no full
							// swipe: both make the list animate the row out, while the
							// row stays put (this only opens the confirm sheet). The
							// count mismatch that follows aborts the app.
							.swipeActions(edge: .trailing, allowsFullSwipe: false) {
								Button {
									pendingDelete = DeleteRequest(sessions: [session])
								} label: {
									Label("Delete", systemImage: "trash")
								}
								.tint(.red)
								Button {
									pendingRename = session
								} label: {
									Label("Rename", systemImage: "pencil")
								}
								.tint(.indigo)
								Button {
									setHidden(session, true)
								} label: {
									Label("Hide", systemImage: "eye.slash")
								}
								.tint(.gray)
							}
						}
					} header: {
						if isFiltering && !listedSessions.isEmpty { Text("Sessions") }
					}

					// What was said, under the names, for when a phrase is all you
					// remember.
					if isFiltering {
						Section {
							ForEach(hits) { hit in
								link(to: SessionTarget(sessionId: hit.sessionId, index: hit.index)) {
									transcriptHitRow(hit)
								}
							}
							if hits.isEmpty && listedSessions.isEmpty {
								Text(searching ? "Searching…" : "Nothing matches that.")
									.font(.subheadline)
									.foregroundStyle(.secondary)
							}
						} header: {
							if !hits.isEmpty { Text("In what was said") }
						}
					}

					hiddenSection
				}
				.listStyle(.plain)
			}
		}
		.safeAreaInset(edge: .top, spacing: 0) {
			VStack(spacing: 8) {
				ServerTooOldBanner()
				PairingBanner()
			}
		}
		.navigationTitle("Sessions")
		.searchable(text: $query, prompt: "Search sessions")
		.onChange(of: query) { _, text in runSearch(text) }
		.refreshable { await store.refreshSessions() }
		.toolbar {
			if !store.activeSessions.isEmpty && deleteProgress == nil {
				ToolbarItem(placement: .topBarTrailing) {
					if isSelecting {
						Button("Done") { endSelecting() }
					} else {
						Button("Select") { isSelecting = true }
					}
				}
			}
			ToolbarItem(placement: .topBarLeading) {
				Button {
					if let openSettingsTab { openSettingsTab() } else { pushSettings = true }
				} label: {
					Image(systemName: "gearshape")
				}
				.accessibilityLabel("Settings")
				.accessibilityIdentifier("openSettings")
			}
			if store.reviews?.isShown == true {
				ToolbarItem(placement: .topBarLeading) {
					Button { showReviews = true } label: {
						Image(systemName: "checklist")
					}
					.accessibilityLabel("Reviews")
					.accessibilityIdentifier("openReviews")
				}
			}
		}
		.navigationDestination(isPresented: $pushSettings) {
			SettingsView()
		}
		.sheet(isPresented: $showReviews) {
			ReviewsView { sessionId in open = SessionTarget(sessionId: sessionId) }
		}
		// A bar of our own rather than .bottomBar toolbar items: the tab bar
		// owns the bottom of the screen, so those never show up.
		.safeAreaInset(edge: .bottom) {
			if let deleteProgress {
				progressBar(deleteProgress)
			} else if isSelecting && !store.activeSessions.isEmpty {
				selectionBar
			}
		}
		.onChange(of: store.activeSessions.map(\.id)) { _, ids in
			selection.formIntersection(ids)
			if ids.isEmpty { endSelecting() }
		}
		.sheet(item: $pendingDelete) { request in
			DeleteSessionSheet(
				hasWorktree: request.sessions.contains { $0.worktree != nil },
				count: request.sessions.count
			) { deleteWorktree, deleteBranch in
				Task { await delete(request.sessions, worktree: deleteWorktree, branch: deleteBranch) }
			}
		}
		.sheet(item: $pendingRename) { session in
			RenameSessionSheet(current: session.title ?? "") { newTitle in
				do {
					let id = try await store.rename(sessionId: session.id, title: newTitle)
					// A renamed tmux terminal moves to a new id, so keep the
					// open session pointed at it rather than letting it vanish.
					if id != session.id, open?.sessionId == session.id {
						open = SessionTarget(sessionId: id)
					}
					return nil
				} catch {
					return error.localizedDescription
				}
			}
		}
		.alert("Couldn't delete", isPresented: Binding(
			get: { deleteError != nil },
			set: { if !$0 { deleteError = nil } }
		)) {
			Button("OK", role: .cancel) { deleteError = nil }
		} message: {
			Text(deleteError ?? "")
		}
	}

	/// The bottom of the list: what has been hidden, collapsed until you open
	/// it, and the only place it can be brought back from. Absent entirely until
	/// something is hidden.
	@ViewBuilder
	private var hiddenSection: some View {
		if !listedHidden.isEmpty {
			Section {
				// The disclosure is built here rather than with
				// Section(isExpanded:), which only draws its own control under the
				// sidebar list style; this list is plain.
				Button {
					hiddenExpanded.toggle()
				} label: {
					HStack(spacing: 8) {
						Image(systemName: hiddenExpanded ? "chevron.down" : "chevron.right")
							.font(.caption)
						Text("Hidden")
						Text("\(listedHidden.count)")
							.foregroundStyle(.secondary)
						Spacer()
					}
					.font(.subheadline.weight(.semibold))
					.foregroundStyle(.secondary)
					.contentShape(Rectangle())
				}
				.buttonStyle(.plain)

				if hiddenExpanded {
					hiddenRows
				}
			}
		}
	}

	/// A row per hidden project, then the hidden sessions themselves.
	@ViewBuilder
	private var hiddenRows: some View {
		ForEach(hidingProjects) { project in
			Button {
				Task { try? await store.setHidden(projectPath: project.path, hidden: false) }
			} label: {
				Label("Unhide \(project.name)", systemImage: "eye")
					.font(.subheadline)
					.frame(maxWidth: .infinity, alignment: .leading)
					.contentShape(Rectangle())
			}
			.buttonStyle(.plain)
		}
		ForEach(listedHidden) { session in
			link(to: SessionTarget(sessionId: session.id)) {
				SessionRow(session: session)
			}
			.swipeActions(edge: .trailing, allowsFullSwipe: false) {
				// A session its project hides would stay hidden if unhidden on its
				// own, so the row offers nothing and the project button above is
				// what brings it back.
				if !SessionProject.hides(session, in: store.projects) {
					Button {
						setHidden(session, false)
					} label: {
						Label("Unhide", systemImage: "eye")
					}
					.tint(.gray)
				}
			}
		}
	}

	/// One transcript hit: which session said it, when, and the snippet.
	@ViewBuilder
	private func transcriptHitRow(_ hit: SearchHit) -> some View {
		VStack(alignment: .leading, spacing: 3) {
			HStack(spacing: 6) {
				Image(systemName: hit.role == "user" ? "person" : "sparkles")
					.font(.caption2)
				Text(hit.title).font(.caption).lineLimit(1)
				Spacer()
				Text(RelativeFormat.string(hit.at)).font(.caption2)
			}
			.foregroundStyle(.secondary)
			Text(hit.snippet).font(.subheadline).lineLimit(3)
		}
		.padding(.vertical, 2)
	}

	/// Debounced so typing doesn't fire a scan per keystroke.
	private func runSearch(_ text: String) {
		searchTask?.cancel()
		let q = text.trimmingCharacters(in: .whitespaces)
		// Without transcript search the field still filters the list by title.
		guard q.count >= 2, store.supports(.search) else {
			hits = []
			searching = false
			return
		}
		searching = true
		searchTask = Task {
			try? await Task.sleep(for: .milliseconds(300))
			guard !Task.isCancelled else { return }
			let response = try? await store.client?.search(query: q)
			// A newer keystroke owns the results now; a late answer would
			// put back hits the field has already cleared.
			guard !Task.isCancelled else { return }
			if let response { hits = response.hits }
			searching = false
		}
	}

	private var selectionBar: some View {
		HStack {
			Button(allSelected ? "Deselect All" : "Select All") {
				selection = allSelected ? [] : Set(store.activeSessions.map(\.id))
			}
			Spacer()
			Button(role: .destructive) {
				pendingDelete = DeleteRequest(sessions: selectedSessions)
			} label: {
				Label(selection.isEmpty ? "Delete" : "Delete (\(selection.count))", systemImage: "trash")
			}
			.buttonStyle(.borderedProminent)
			.tint(.red)
			.disabled(selection.isEmpty)
		}
		.padding(.horizontal)
		.padding(.vertical, 10)
		.deckGlass(in: Rectangle())
	}

	private func progressBar(_ progress: DeleteProgress) -> some View {
		VStack(alignment: .leading, spacing: 6) {
			HStack(spacing: 8) {
				ProgressView().controlSize(.small)
				Text(progress.total == 1
					? "Deleting session…"
					: "Deleting \(min(progress.done + 1, progress.total)) of \(progress.total)…")
					.font(.footnote)
					.foregroundStyle(.secondary)
			}
			if progress.total > 1 {
				ProgressView(value: Double(progress.done), total: Double(progress.total))
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.padding(.horizontal)
		.padding(.vertical, 10)
		.deckGlass(in: Rectangle())
	}

	private var selectedSessions: [SessionDigest] {
		store.activeSessions.filter { selection.contains($0.id) }
	}

	private var allSelected: Bool {
		!store.activeSessions.isEmpty && selection.count == store.activeSessions.count
	}

	private func endSelecting() {
		isSelecting = false
		selection.removeAll()
	}

	private func toggle(_ sessionId: String) {
		if selection.contains(sessionId) {
			selection.remove(sessionId)
		} else {
			selection.insert(sessionId)
		}
	}

	private func delete(_ sessions: [SessionDigest], worktree: Bool, branch: Bool) async {
		// Out of selection mode before the first request: the batch runs on its
		// own from here, and the progress bar takes over the same spot.
		endSelecting()
		deleteProgress = DeleteProgress(done: 0, total: sessions.count)
		defer { deleteProgress = nil }
		do {
			let failures = try await store.deleteSessions(
				sessionIds: sessions.map(\.id), deleteWorktree: worktree, deleteBranch: branch,
				onProgress: { done in deleteProgress?.done = done })
			if let first = failures.values.sorted().first {
				deleteError = failures.count == 1
					? first
					: "\(failures.count) of \(sessions.count) sessions couldn't be deleted. \(first)"
			}
		} catch {
			deleteError = error.localizedDescription
		}
	}
}

/// The open session's model, kept across folds and unfolds (which lay the
/// session out afresh) so its transcript stream and voice mode carry on.
@MainActor
final class OpenSessionModel {
	private var current: SessionDetailViewModel?
	private var target: SessionsView.SessionTarget?

	func model(for target: SessionsView.SessionTarget, store: DeckStore) -> SessionDetailViewModel {
		if self.target == target, let current { return current }
		current?.leave()
		let model = SessionDetailViewModel(sessionId: target.sessionId, store: store)
		current = model
		self.target = target
		return model
	}

	func close() {
		current?.leave()
		current = nil
		target = nil
	}
}

private struct DeleteProgress {
	var done: Int
	var total: Int
}

private struct DeleteRequest: Identifiable {
	let id = UUID()
	let sessions: [SessionDigest]
}
