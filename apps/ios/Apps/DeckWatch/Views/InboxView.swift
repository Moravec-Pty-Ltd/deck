import SwiftUI
import DeckKit

struct InboxView: View {
	@Environment(DeckStore.self) private var store

	/// Runs still going, for status only: driving a run belongs on the phone.
	private var activeRuns: [RunDigest] {
		store.board.filter { !$0.status.isFinished }
	}

	var body: some View {
		Group {
			if store.asks.isEmpty && activeRuns.isEmpty {
				ContentUnavailableView("Nothing needs you", systemImage: "checkmark.circle")
			} else {
				List {
					ForEach(store.asks) { ask in
						NavigationLink(value: ask) {
							AskRow(title: title(for: ask), ask: ask)
						}
					}
					if !activeRuns.isEmpty {
						Section("Runs") {
							ForEach(activeRuns) { run in
								RunStatusRow(run: run)
							}
						}
					}
				}
			}
		}
		.navigationTitle("Inbox")
		.refreshable {
			await store.refreshAsks()
			await store.refreshRuns()
		}
	}

	private func title(for ask: DeckAsk) -> String {
		// A blocked run's question carries the run's title as its header.
		if ask.runId != nil { return ask.questions.first?.header ?? "Workflow run" }
		return store.sessions.first { $0.id == ask.sessionId }?.title ?? ask.sessionId
	}
}

private struct AskRow: View {
	let title: String
	let ask: DeckAsk

	var body: some View {
		VStack(alignment: .leading, spacing: 2) {
			Text(title).font(.headline).lineLimit(1)
			if let question = ask.questions.first {
				Text(ask.runId != nil ? question.question : question.header ?? question.question)
					.font(.caption)
					.foregroundStyle(.secondary)
					.lineLimit(2)
			}
		}
	}
}

private struct RunStatusRow: View {
	let run: RunDigest

	var body: some View {
		VStack(alignment: .leading, spacing: 2) {
			Text(run.title).font(.headline).lineLimit(1)
			Text("\(run.status.label) · \(run.currentPhase?.label ?? run.phase)")
				.font(.caption)
				.foregroundStyle(run.status == .blocked ? .orange : .secondary)
				.lineLimit(1)
		}
	}
}
