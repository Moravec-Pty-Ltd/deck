import SwiftUI
import DeckKit

@main
struct DeckMacMain: App {
	@State private var store = DeckStore()

	var body: some Scene {
		WindowGroup {
			MacRootView()
				.environment(store)
				.frame(minWidth: 760, minHeight: 480)
				.task { store.start() }
		}
		.commands {
			CommandGroup(after: .appSettings) {
				Button("Sign Out") { store.signOut() }
					.disabled(!store.isSignedIn)
			}
		}

		// Listed in the Window menu, so it needs no button of its own.
		Window("Browser", id: "browser") {
			MacBrowserView().environment(store)
		}
		.keyboardShortcut("b", modifiers: [.command, .shift])
	}
}

struct MacRootView: View {
	@Environment(DeckStore.self) private var store

	var body: some View {
		if store.isSignedIn {
			MacSessionsView()
		} else {
			MacSignInView()
		}
	}
}
