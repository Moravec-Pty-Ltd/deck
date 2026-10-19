import SwiftUI
import DeckKit
import DeckUI

/// Window ids, for `openWindow`.
enum MacWindow {
	static let main = "main"
	static let session = "session"
}

@main
struct DeckMacMain: App {
	@NSApplicationDelegateAdaptor(MacAppDelegate.self) private var appDelegate
	@State private var store = DeckStore()

	var body: some Scene {
		WindowGroup(id: MacWindow.main) {
			MacRootView()
				.environment(store)
				.frame(minWidth: 760, minHeight: 480)
				.task { store.start() }
		}
		.commands {
			DeckCommands()
			MacCommands(store: store)
		}

		// One session on its own, from a double-click in the list or its
		// "Open in New Window". Restored with the session it showed.
		WindowGroup("Session", id: MacWindow.session, for: String.self) { $sessionId in
			MacSessionWindow(sessionId: sessionId)
				.environment(store)
				.frame(minWidth: 520, minHeight: 420)
		}

		Settings {
			MacSettingsView().environment(store)
		}

		// Listed in the Window menu, so it needs no button of its own.
		Window("Browser", id: "browser") {
			MacBrowserView().environment(store)
		}
		.keyboardShortcut("b", modifiers: [.command, .shift])

		Window("Operator", id: "operator") {
			OperatorView()
				.environment(store)
				.frame(minWidth: 420, minHeight: 480)
		}
		.keyboardShortcut("o", modifiers: [.command, .shift])

		MenuBarExtra {
			MenuBarContent().environment(store)
		} label: {
			MenuBarIcon().environment(store)
		}
		.menuBarExtraStyle(.window)
	}
}

/// The Mac's additions to DeckCommands: ⌘N is New Session there, so a new
/// window moves to ⇧⌘N.
struct MacCommands: Commands {
	let store: DeckStore
	@Environment(\.openWindow) private var openWindow

	var body: some Commands {
		CommandGroup(after: .newItem) {
			Button("New Window") { openWindow(id: MacWindow.main) }
				.keyboardShortcut("n", modifiers: [.command, .shift])
		}
		CommandGroup(after: .appSettings) {
			Button("Sign Out") { store.signOut() }
				.disabled(!store.isSignedIn)
		}
	}
}

struct MacRootView: View {
	@Environment(DeckStore.self) private var store

	var body: some View {
		if store.isSignedIn {
			MacMainView().modifier(PairingPrompt())
		} else {
			MacSignInView()
		}
	}
}
