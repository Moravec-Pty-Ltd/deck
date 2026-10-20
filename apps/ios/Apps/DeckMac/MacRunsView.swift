import SwiftUI
import DeckKit
import DeckUI

/// The runs board on its own, as the web's Runs page: the overseer, every run,
/// and a run's phases one level down. The phone keeps these in its inbox.
struct MacRunsView: View {
	@Environment(DeckStore.self) private var store
	@State private var path = NavigationPath()
	@State private var starting = false
	@State private var errorMessage: String?

	var body: some View {
		NavigationStack(path: $path) {
			Group {
				if store.runs.isEmpty && store.overseer == nil {
					ContentUnavailableView {
						Label("No runs", systemImage: "point.3.connected.trianglepath.dotted")
					} actions: {
						Button("Start a run") { starting = true }
					}
				} else {
					board
				}
			}
			.navigationTitle("Runs")
			.toolbar { toolbar }
			.sheet(isPresented: $starting) {
				StartRunView { run in path.append(RunRoute(id: run.id)) }
					.frame(minWidth: 480, minHeight: 480)
			}
			.alert("Couldn't do that", isPresented: Binding(
				get: { errorMessage != nil },
				set: { if !$0 { errorMessage = nil } }
			)) {
				Button("OK", role: .cancel) { errorMessage = nil }
			} message: {
				Text(errorMessage ?? "")
			}
			.navigationDestination(for: String.self) { MacSessionDetail(sessionId: $0) }
			.navigationDestination(for: RunRoute.self) { route in
				RunView(runId: route.id) { path.append($0) }
			}
			.navigationDestination(for: PhaseRoute.self) { PhaseView(route: $0) }
		}
		.task { await store.refreshRuns() }
	}

	private var board: some View {
		List {
			if let overseer = store.overseer, let sessionId = overseer.sessionId {
				NavigationLink(value: sessionId) { OverseerRow(overseer: overseer) }
			}
			ForEach(store.board) { run in
				NavigationLink(value: RunRoute(id: run.id)) { RunRow(run: run) }
					.contextMenu {
						Button("Delete Run", role: .destructive) {
							act { try await store.deleteRun(id: run.id) }
						}
					}
			}
		}
	}

	@ToolbarContentBuilder
	private var toolbar: some ToolbarContent {
		if store.runs.contains(where: { $0.status.isFinished }) {
			ToolbarItem {
				Button("Clear Finished") {
					act { _ = try await store.deleteFinishedRuns() }
				}
			}
		}
		ToolbarItem(placement: .primaryAction) {
			Button("Start a Run", systemImage: "plus") { starting = true }
		}
		ToolbarItem {
			Button("Refresh", systemImage: "arrow.clockwise") {
				Task { await store.refreshRuns() }
			}
		}
	}

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
}
