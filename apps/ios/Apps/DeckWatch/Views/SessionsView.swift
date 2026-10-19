import SwiftUI
import DeckKit

struct SessionsView: View {
	@Environment(DeckStore.self) private var store

	var body: some View {
		Group {
			if store.activeSessions.isEmpty {
				ContentUnavailableView("No sessions yet", systemImage: "bolt.horizontal.circle")
			} else {
				List {
					let missing = store.missing([.stream, .speech, .voiceOperator, .quickMessages])
					if !missing.isEmpty {
						Text("deck is older than this app: update it for \(missing.map(\.label).formatted(.list(type: .and))).")
							.font(.caption2)
							.foregroundStyle(.orange)
					}
					ForEach(store.activeSessions) { session in
						NavigationLink(value: session) {
							SessionRow(session: session, needsYou: hasAsk(session))
						}
					}
				}
			}
		}
		.navigationTitle("Sessions")
		.task { await store.refreshSessions() }
		.refreshable { await store.refreshSessions() }
	}

	private func hasAsk(_ session: SessionDigest) -> Bool {
		store.asks.contains { $0.sessionId == session.id }
	}
}

private struct SessionRow: View {
	let session: SessionDigest
	let needsYou: Bool

	var body: some View {
		HStack(spacing: 8) {
			Circle()
				.fill(dotColor)
				.frame(width: 8, height: 8)
			VStack(alignment: .leading, spacing: 2) {
				Text(session.title ?? session.id).font(.body).lineLimit(1)
				Text(relativeTime).font(.caption2).foregroundStyle(.secondary)
			}
			Spacer(minLength: 4)
			if needsYou {
				Text("needs you")
					.font(.caption2)
					.foregroundStyle(.orange)
			}
		}
	}

	private var dotColor: Color {
		if session.awaitingInput == true { return .orange }
		switch session.status {
		case .running: return .green
		case .idle: return .gray
		case .error, .dead: return .red
		case .unknown: return .gray
		}
	}

	private var relativeTime: String {
		guard let ms = session.lastActiveAt else { return "" }
		let date = Date(timeIntervalSince1970: ms / 1000)
		return date.formatted(.relative(presentation: .named))
	}
}
