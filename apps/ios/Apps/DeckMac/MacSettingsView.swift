import SwiftUI
import DeckKit
import DeckUI

/// The Settings window (⌘,): the account on this Mac, then the deck server's
/// projects (with their dev servers and issue sources) and its own settings,
/// through the same forms as the phone.
struct MacSettingsView: View {
	@Environment(DeckStore.self) private var store

	var body: some View {
		TabView {
			Tab("Account", systemImage: "person.crop.circle") {
				MacAccountSettings()
			}
			Tab("Projects", systemImage: "folder") {
				signedIn { NavigationStack { ProjectsSettingsView() } }
			}
			Tab("deck Server", systemImage: "server.rack") {
				signedIn { NavigationStack { ServerSettingsView() } }
			}
			Tab("Operator", systemImage: "waveform") {
				NavigationStack { LocalModelView() }
			}
		}
		.frame(minWidth: 620, idealWidth: 680, minHeight: 460, idealHeight: 560)
	}

	@ViewBuilder
	private func signedIn(@ViewBuilder _ content: () -> some View) -> some View {
		if store.isSignedIn {
			content()
		} else {
			ContentUnavailableView("Not signed in", systemImage: "person.crop.circle.badge.questionmark", description: Text("Sign in to deck in the main window first."))
		}
	}
}

private struct MacAccountSettings: View {
	@Environment(DeckStore.self) private var store
	@State private var confirmSignOut = false

	var body: some View {
		Form {
			if let baseURL = store.client?.credentials.baseURL {
				LabeledContent("Server", value: baseURL.absoluteString)
				LabeledContent("Status") { status }
				if let login = store.userLogin {
					LabeledContent("GitHub", value: login)
				}
				LabeledContent("Needs attention", value: "\(store.awaitingCount)")
				Section {
					Button("Sign Out…", role: .destructive) { confirmSignOut = true }
				}
			} else {
				Text("Not signed in. Sign in from the main window.")
					.foregroundStyle(.secondary)
			}
		}
		.formStyle(.grouped)
		.confirmationDialog("Sign out of deck?", isPresented: $confirmSignOut) {
			Button("Sign Out", role: .destructive) { store.signOut() }
			Button("Cancel", role: .cancel) {}
		} message: {
			Text("This Mac forgets its token. Sign in again with a pairing code or a pasted token.")
		}
	}

	@ViewBuilder
	private var status: some View {
		switch store.connection {
		case .signedOut: Text("Signed out").foregroundStyle(.secondary)
		case .connecting: Text("Connecting").foregroundStyle(.secondary)
		case .live: Label("Live", systemImage: "circle.fill").foregroundStyle(.green)
		case .offline(let reason): Text("Offline: \(reason)").foregroundStyle(.red)
		}
	}
}
