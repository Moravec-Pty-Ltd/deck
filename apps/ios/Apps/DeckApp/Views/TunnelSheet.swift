import DeckBrowser
import DeckUI
import SwiftUI

/// Where the tunnel to the deck machine's localhost stands. Nothing to fill
/// in: it rides on the deck sign-in. The Mac target compiles this file by path.
struct TunnelSheet: View {
	var model: BrowserModel
	@Environment(\.dismiss) private var dismiss

	var body: some View {
		DeckFormSheet("Tunnel", width: 460) {
			Form {
				Section {
					LabeledContent("Tunnel", value: model.status)
					if !model.lastForward.isEmpty {
						LabeledContent("Last request", value: model.lastForward)
							.font(.caption.monospaced())
					}
				} footer: {
					Text("Each request goes through deck, signed in as this app. Only this app connects to the local port.")
				}

				Section {
					Button("Reconnect") { model.connect() }
				}
			}
			.formStyle(.grouped)
			.toolbar {
				ToolbarItem(placement: .confirmationAction) {
					Button("Done") { dismiss() }
				}
			}
		}
	}
}
