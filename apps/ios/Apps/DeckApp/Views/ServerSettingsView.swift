import SwiftUI
import DeckKit
import DeckUI

/// The deck server's own settings, shared by every device signed in to it.
/// Everything else in Settings lives on this device only.
struct ServerSettingsView: View {
	@Environment(DeckStore.self) private var store
	@State private var model: ServerSettingsModel?

	var body: some View {
		Form {
			if !store.supports(.settings) {
				Section {
					Text("This deck server is too old to change its settings from the app. Update deck, or use the web app.")
						.foregroundStyle(.secondary)
				}
			} else if let model {
				Section {
					Text("These are saved on the deck server and apply to every device and browser that uses it.")
						.font(.footnote)
						.foregroundStyle(.secondary)
				}
				ServerSettingsSections(model: model)
			} else {
				ProgressView()
			}
		}
		.navigationTitle("deck server")
		.task {
			guard store.supports(.settings), model == nil, let client = store.client else { return }
			let next = ServerSettingsModel(client: client)
			model = next
			await next.load()
		}
		.refreshable { await model?.load() }
	}
}

/// The Settings row that opens it, worded so it reads as the server's.
struct ServerSettingsLink: View {
	var body: some View {
		Section {
			NavigationLink {
				ServerSettingsView()
			} label: {
				Label("deck server settings", systemImage: "server.rack")
			}
			.accessibilityIdentifier("openServerSettings")
		} header: {
			Text("deck server")
		} footer: {
			Text("Voice servers, auto-compact, the watch operator, Zed and agent skills. Saved on the server, not on this device.")
		}
	}
}
