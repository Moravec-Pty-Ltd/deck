import SwiftUI
import WatchKit
import DeckKit

/// No free-text prompt on watch v1: this is a target summary + a single
/// Start button, per the confirmation-only flow.
struct StartConfirmationView: View {
	@Environment(DeckStore.self) private var store
	@Environment(WatchRouter.self) private var router
	let target: StartTarget

	@State private var isStarting = false
	@State private var idempotencyKey = UUID().uuidString
	@State private var started = false
	@State private var errorMessage: String?

	/// Watch v1 starts claude sessions only; the phone picks other kinds.
	private let kind = "claude"

	private var project: DeckProject {
		switch target {
		case .issue(_, let project), .pr(_, let project): return project
		}
	}

	var body: some View {
		VStack(spacing: 12) {
			if started {
				Image(systemName: "checkmark.circle.fill")
					.font(.largeTitle)
					.foregroundStyle(.green)
				Text("Started")
			} else {
				summary
				Button {
					start()
				} label: {
					if isStarting {
						ProgressView()
					} else {
						Text(actionLabel)
					}
				}
				.buttonStyle(.borderedProminent)
				.disabled(isStarting)
			}
		}
		.padding()
		.navigationTitle(actionLabel)
		.task {
			// The last-used model/effort/prompt come from the server's defaults; the
			// watch may not have fetched them yet when this view opens from a
			// complication tap.
			if store.startDefaultsByProject[project.path] == nil { await store.loadStartDefaults(projectPath: project.path) }
		}
		.alert("Couldn't start", isPresented: Binding(
			get: { errorMessage != nil },
			set: { if !$0 { errorMessage = nil } }
		)) {
			Button("OK", role: .cancel) { errorMessage = nil }
		} message: {
			Text(errorMessage ?? "")
		}
	}

	private var actionLabel: String {
		switch target {
		case .issue: return "Start Work"
		case .pr: return "Start Review"
		}
	}

	@ViewBuilder
	private var summary: some View {
		switch target {
		case .issue(let issue, let project):
			VStack(alignment: .leading, spacing: 6) {
				Text(project.name).font(.caption).foregroundStyle(.secondary)
				Text(issue.title ?? issue.shortId).font(.headline)
				Text(issue.shortId).font(.caption2).foregroundStyle(.secondary)
			}
		case .pr(let pr, let project):
			VStack(alignment: .leading, spacing: 6) {
				Text(project.name).font(.caption).foregroundStyle(.secondary)
				Text(pr.title ?? "PR #\(pr.number)").font(.headline)
				Text("#\(pr.number)" + (pr.author.map { " · \($0)" } ?? ""))
					.font(.caption2)
					.foregroundStyle(.secondary)
			}
		}
	}

	private func start() {
		isStarting = true
		Task {
			// Resolve the prompt here rather than letting the server fill it in:
			// deck only dispatches a turn when a prompt is present, so a start
			// with none leaves a session that never runs.
			if store.startDefaultsByProject[project.path] == nil { await store.loadStartDefaults(projectPath: project.path) }
			do {
				switch target {
				case .issue(let issue, let project):
					// Same defaults the web modal applies: last-used model/effort,
					// and a title and new branch named after the issue ref.
					let defaults = store.startDefaults(kind: kind, projectPath: project.path)
					try await store.startWork(
						issue: issue,
						project: project,
						prompt: defaults.firstPrompt ?? FallbackPrompt.work,
						kind: kind,
						title: issue.issueId,
						model: defaults.modelId,
						provider: defaults.model.provider,
						effort: defaults.effort,
						permissionMode: defaults.permissionMode,
						worktree: .newBranch(named: issue.issueId, base: defaults.base),
						idempotencyKey: idempotencyKey)
				case .pr(let pr, let project):
					let defaults = store.startDefaults(
						kind: kind, projectPath: project.path, review: true)
					try await store.startReview(
						pr: pr,
						project: project,
						prompt: defaults.firstPrompt ?? FallbackPrompt.review,
						kind: kind,
						model: defaults.modelId,
						provider: defaults.model.provider,
						effort: defaults.effort,
						permissionMode: defaults.permissionMode,
						idempotencyKey: idempotencyKey)
				}
				WKInterfaceDevice.current().play(.success)
				started = true
				try? await Task.sleep(for: .seconds(1))
				router.show(.sessions)
			} catch {
				errorMessage = error.localizedDescription
			}
			isStarting = false
		}
	}
}
