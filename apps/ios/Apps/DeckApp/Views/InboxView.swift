import SwiftUI
import DeckKit

/// What needs you (session questions and blocked runs), then the runs board.
struct InboxView: View {
	@Environment(DeckStore.self) private var store
	/// A run to open, from a tapped notification.
	@Binding var deepLinkRunId: String?
	@State private var path = NavigationPath()
	@State private var errorMessage: String?
	@State private var starting = false

	var body: some View {
		NavigationStack(path: $path) {
			Group {
				if store.asks.isEmpty && store.runs.isEmpty && overseerSession == nil {
					ContentUnavailableView {
						Label("Nothing needs you", systemImage: "tray")
					} actions: {
						Button("Start a run") { starting = true }
					}
				} else {
					List {
						Section {
							ForEach(store.asks) { ask in
								AskRow(ask: ask, sessionTitle: title(for: ask)) {
									if let runId = ask.runId {
										path.append(RunRoute(id: runId))
									} else {
										path.append(ask.sessionId)
									}
								} onQuickAnswer: { label in
									// The same text and recorded pick the full card sends, so the
									// transcript shows the shortcut answer like any other.
									var draft = AskAnswerDraft(questions: ask.questions)
									draft.toggle(label, question: 0)
									Task { try? await store.answer(ask: ask, text: draft.text, answers: draft.answers) }
								}
							}
						} header: {
							if !store.asks.isEmpty && !store.runs.isEmpty { Text("Needs you") }
						}

						if !store.runs.isEmpty || overseerSession != nil {
							Section("Runs") {
								if let overseer = store.overseer, let sessionId = overseerSession {
									NavigationLink(value: sessionId) {
										OverseerRow(overseer: overseer)
									}
								}
								ForEach(store.board) { run in
									NavigationLink(value: RunRoute(id: run.id)) {
										RunRow(run: run)
									}
									.accessibilityIdentifier("run-\(run.id)")
									// Same as the sessions list: no full swipe, so the row
									// only goes once deck has deleted it.
									.swipeActions(edge: .trailing, allowsFullSwipe: false) {
										Button {
											act { try await store.deleteRun(id: run.id) }
										} label: {
											Label("Delete", systemImage: "trash")
										}
										.tint(.red)
									}
								}
							}
						}
					}
					.listStyle(.plain)
				}
			}
			.navigationTitle("Inbox")
			.toolbar {
				if store.runs.contains(where: { $0.status.isFinished }) {
					ToolbarItem(placement: .topBarTrailing) {
						Button("Clear finished") {
							act { try await store.deleteFinishedRuns() }
						}
					}
				}
				ToolbarItem(placement: .topBarTrailing) {
					Button("Start a run", systemImage: "plus") { starting = true }
				}
			}
			.sheet(isPresented: $starting) {
				StartRunView { run in path.append(RunRoute(id: run.id)) }
			}
			.alert("Couldn't do that", isPresented: Binding(
				get: { errorMessage != nil },
				set: { if !$0 { errorMessage = nil } }
			)) {
				Button("OK", role: .cancel) { errorMessage = nil }
			} message: {
				Text(errorMessage ?? "")
			}
			.navigationDestination(for: String.self) { sessionId in
				SessionDetailView(sessionId: sessionId)
			}
			.navigationDestination(for: RunRoute.self) { route in
				RunView(runId: route.id) { path.append($0) }
			}
			.navigationDestination(for: PhaseRoute.self) { route in
				PhaseView(route: route)
			}
			.refreshable {
				await store.refreshAsks()
				await store.refreshRuns()
			}
		}
		.onChange(of: deepLinkRunId, initial: true) { _, runId in
			guard let runId else { return }
			path = NavigationPath([RunRoute(id: runId)])
			deepLinkRunId = nil
		}
	}

	private var overseerSession: String? { store.overseer?.sessionId }

	private func act(_ action: @escaping () async throws -> Void) {
		Task {
			do {
				try await action()
			} catch DeckError.http(_, let message) {
				errorMessage = message
			} catch {
				errorMessage = error.localizedDescription
			}
		}
	}

	private func title(for ask: DeckAsk) -> String {
		// The question's header already names the run.
		if let runId = ask.runId {
			return store.runs.first { $0.id == runId }.map { "\($0.projectName) · workflow run" } ?? "Workflow run"
		}
		guard let session = store.sessions.first(where: { $0.id == ask.sessionId }) else { return ask.sessionId }
		if let title = session.title, !title.isEmpty { return title }
		if let cwd = session.cwd, let last = cwd.split(separator: "/").last { return String(last) }
		return ask.sessionId
	}
}

struct AskRow: View {
	let ask: DeckAsk
	let sessionTitle: String
	var onTap: () -> Void
	var onQuickAnswer: (String) -> Void

	var body: some View {
		// A plain tap-gesture region (not a Button) so the nested quick-answer
		// Buttons below remain independently tappable.
		VStack(alignment: .leading, spacing: 6) {
			Text(sessionTitle)
				.font(.caption)
				.foregroundStyle(.secondary)

			ForEach(Array(ask.questions.enumerated()), id: \.offset) { _, question in
				VStack(alignment: .leading, spacing: 4) {
					if let header = question.header, !header.isEmpty {
						Text(header).font(.caption.weight(.semibold))
					}
					Text(question.question)
						.font(.body)
						.foregroundStyle(.primary)

					if ask.questions.count == 1, question.multiSelect != true, let options = question.options, !options.isEmpty {
						HStack {
							ForEach(options.prefix(3), id: \.label) { option in
								Button(option.label) {
									onQuickAnswer(option.label)
								}
								.buttonStyle(.bordered)
								.controlSize(.small)
							}
						}
					}
				}
			}
		}
		.padding(.vertical, 4)
		.contentShape(Rectangle())
		.onTapGesture(perform: onTap)
	}
}

/// The overseer's session, one tap from the board rather than a hunt through
/// the sessions list.
struct OverseerRow: View {
	let overseer: Overseer

	var body: some View {
		HStack(spacing: 6) {
			Text("Overseer").font(.body.weight(.medium))
			// Not `busy`: nothing in the event log refreshes it, so it would go stale.
			Chip(text: overseer.active ? "watching" : "stopped", color: overseer.active ? .accentColor : .secondary)
			Spacer()
		}
		.padding(.vertical, 4)
	}
}
