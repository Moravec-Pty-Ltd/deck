import SwiftUI
import DeckKit
import DeckUI

struct MacSessionsView: View {
	@Environment(DeckStore.self) private var store
	@State private var selection: String?

	var body: some View {
		NavigationSplitView {
			sidebar
				.navigationSplitViewColumnWidth(min: 240, ideal: 300)
		} detail: {
			if let selection {
				MacSessionDetail(sessionId: selection)
					.id(selection)
			} else {
				ContentUnavailableView("No session selected", systemImage: "bubble.left.and.text.bubble.right")
			}
		}
	}

	private var sidebar: some View {
		List(selection: $selection) {
			if store.serverTooOld {
				ServerTooOldBanner()
			}
			Section {
				ForEach(store.activeSessions) { session in
					SessionRow(session: session).tag(session.id)
				}
			}
			if !store.hiddenSessions.isEmpty {
				Section("Hidden") {
					ForEach(store.hiddenSessions) { session in
						SessionRow(session: session).tag(session.id)
					}
				}
			}
		}
		.overlay {
			if store.sessions.isEmpty, store.connection == .live {
				ContentUnavailableView("No sessions", systemImage: "tray")
			}
		}
		.safeAreaInset(edge: .bottom) { connectionStatus }
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
	private var connectionStatus: some View {
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
