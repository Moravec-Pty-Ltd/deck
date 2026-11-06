import SwiftUI
import DeckKit
import DeckUI

/// The sheets a session opens from its menu, its PR header or its composer.
enum MacSessionSheet: Identifiable {
	case delete, changes, servers, files, schedule, model, effort, rename, merge, review, quickMessages

	var id: Self { self }
}

/// The session's actions menu, as the phone's: agent and model, thinking,
/// compact and restart, rename, changes, dev servers, schedule, Open in Zed, its
/// links, and delete.
struct MacSessionMenu: View {
	let session: SessionDigest?
	let viewModel: SessionDetailViewModel
	let compacting: Bool
	@Binding var sheet: MacSessionSheet?
	var onCompact: () -> Void
	var onModel: () -> Void

	@Environment(DeckStore.self) private var store
	@Environment(\.openURL) private var openURL
	@State private var zedInstalled = false
	@State private var zed: ZedLink?

	private var isClaude: Bool { session?.kind == "claude" }
	private var isRunning: Bool { session?.status == .running }
	private var hasLinks: Bool {
		let pr = session?.pr
		return pr?.url.flatMap(URL.init(string:)) != nil || (pr != nil && store.supports(.prDismiss))
			|| (session?.issues ?? []).contains { $0.url.flatMap(URL.init(string:)) != nil }
	}

	var body: some View {
		Menu {
			agentItems
			sessionItems
			linkItems
			Divider()
			destructiveItems
		} label: {
			Label("Session Actions", systemImage: "ellipsis.circle")
		}
		.accessibilityIdentifier("sessionMenu")
		.task(id: store.supports(.zed)) { await refreshZed() }
		// Coming back from installing Zed, turning on Remote Login, or Settings
		// (a window of this app, so the app itself never reactivates).
		.onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { _ in
			Task { await refreshZed() }
		}
	}

	@ViewBuilder
	private var agentItems: some View {
		if session?.kind != "shell" {
			Menu("Agent: \(session?.kind ?? "default")", systemImage: "arrow.triangle.swap") {
				ForEach(store.kinds.filter { $0.available && $0.kind != "shell" }) { agent in
					Button(agent.kind) { Task { await viewModel.changeAgent(agent.kind) } }
						.disabled(agent.kind == session?.kind)
				}
			}
			.disabled(isRunning)
			Button(session?.model.map { "Model: \($0)" } ?? "Change Model…", systemImage: "cpu", action: onModel)
		}
		if isClaude {
			Button(session?.effort.map { "Thinking: \($0)" } ?? "Thinking Level…", systemImage: "brain") { sheet = .effort }
			if let account = session?.account, !account.isEmpty {
				Button("Account: \(account)", systemImage: "person.crop.circle") {}
					.disabled(true)
			}
			if let context = session?.context {
				Button("Compact Context (\(context.percent)%)", systemImage: "arrow.down.right.and.arrow.up.left", action: onCompact)
					.disabled(isRunning || compacting)
			}
		}
	}

	@ViewBuilder
	private var destructiveItems: some View {
		if isClaude {
			// deck restarts only an idle session (a running turn is a 409).
			Button("Restart claude", systemImage: "arrow.clockwise") { Task { await viewModel.restart() } }
				.disabled(isRunning)
		}
		Button("Delete Session…", systemImage: "trash", role: .destructive) { sheet = .delete }
	}

	@ViewBuilder
	private var sessionItems: some View {
		Divider()
		Button("Rename…", systemImage: "pencil") { sheet = .rename }
		if store.supports(.diff) {
			Button("Changes", systemImage: "plus.forwardslash.minus") { sheet = .changes }
		}
		if store.supports(.servers) {
			Button("Dev Servers", systemImage: "server.rack") { sheet = .servers }
		}
		if store.supports(.filesBrowser) {
			Button("Files", systemImage: "folder") { sheet = .files }
		}
		Button("Repeat on a Schedule…", systemImage: "clock.arrow.2.circlepath") { sheet = .schedule }
		if zedInstalled, store.supports(.zed), let zed, zed.url != nil {
			let sshOff = zed.sshReachable == false
			Button(sshOff ? "Open in Zed (Turn on Remote Login on the deck host)" : "Open in Zed", systemImage: "chevron.left.forwardslash.chevron.right") {
				Task { await openInZed() }
			}
			.disabled(sshOff)
		}
	}

	private func refreshZed() async {
		zedInstalled = NSWorkspace.shared.urlForApplication(toOpen: URL(string: "zed://")!) != nil
		guard zedInstalled, store.supports(.zed), let client = store.client else { return }
		if let fresh = try? await client.zedLink(sessionId: viewModel.sessionId) { zed = fresh }
	}

	/// Fetched again so a Zed SSH target changed in Settings applies straight away.
	private func openInZed() async {
		await refreshZed()
		guard zed?.sshReachable != false, let link = zed?.url.flatMap(URL.init(string:)) else { return }
		NSWorkspace.shared.open(link)
	}

	@ViewBuilder
	private var linkItems: some View {
		if hasLinks { Divider() }
		ForEach(session?.issues ?? [], id: \.id) { issue in
			if let urlString = issue.url, let link = URL(string: urlString) {
				Button(issue.repo.map { "Issue \(issue.shortId) · \($0)" } ?? "Issue \(issue.shortId)", systemImage: "smallcircle.filled.circle") {
					openURL(link)
				}
			}
		}
		if let pr = session?.pr {
			if let urlString = pr.url, let link = URL(string: urlString) {
				Button(String("PR #\(pr.number ?? 0)"), systemImage: "arrow.triangle.pull") { openURL(link) }
			}
			if store.supports(.prDismiss) {
				Button("Dismiss PR", systemImage: "xmark.circle") { Task { await viewModel.dismissPR() } }
			}
		}
	}
}

/// What each sheet shows. The tool windows get a window's size; the dialogs
/// size themselves.
struct MacSessionSheetContent: View {
	let sheet: MacSessionSheet
	let sessionId: String
	let title: String
	let session: SessionDigest?
	let viewModel: SessionDetailViewModel
	var onModelPicked: (String?) -> Void
	var onIdChanged: ((String) -> Void)?
	var onDeleted: (() -> Void)?

	@Environment(DeckStore.self) private var store

	var body: some View {
		switch sheet {
		case .delete, .model, .effort, .rename, .merge, .review:
			content
		case .changes, .servers, .files, .schedule, .quickMessages:
			content.frame(minWidth: 460, idealWidth: 560, minHeight: 360, idealHeight: 520)
		}
	}

	@ViewBuilder
	private var content: some View {
		switch sheet {
		case .delete:
			DeleteSessionSheet(hasWorktree: session?.worktree != nil, name: title, sessions: session.map { [$0] } ?? []) { deleteWorktree, deleteBranch in
				Task {
					if await viewModel.delete(deleteWorktree: deleteWorktree, deleteBranch: deleteBranch) { onDeleted?() }
				}
			}
		case .changes: ChangesSheet(sessionId: sessionId, title: title)
		case .servers: ServersSheet(sessionId: sessionId, title: title)
		case .files: FilesSheet(sessionId: sessionId, viewModel: viewModel)
		case .schedule: NavigationStack { SchedulesView(startFor: sessionId) }
		case .model:
			ModelPickerSheet(kind: session?.kind ?? "claude", current: session?.model, available: store.knownModels(for: session?.kind ?? "claude"), onSelect: onModelPicked)
		case .effort:
			EffortPickerSheet(current: session?.effort) { effort in Task { await viewModel.changeEffort(effort) } }
		case .rename:
			RenameSessionSheet(current: title) { newTitle in
				do {
					let id = try await store.rename(sessionId: sessionId, title: newTitle)
					if id != sessionId { onIdChanged?(id) }
					return nil
				} catch {
					return error.localizedDescription
				}
			}
		case .merge:
			MergeSheet(pr: session?.pr) { method, deleteBranch in
				Task { await viewModel.merge(method: method, deleteBranch: deleteBranch) }
			}
		case .quickMessages: QuickMessagesSheet()
		case .review:
			ReviewSheet(allowsVerdict: session?.isReviewSession == true) { decision, body in
				Task { await viewModel.review(decision: decision, body: body) }
			}
		}
	}
}
