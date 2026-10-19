import SwiftUI
import DeckKit

@main
struct DeckAppMain: App {
	@UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
	@State private var store = DeckStore()
	private let watchSync = WatchSync()

	var body: some Scene {
		WindowGroup {
			RootView()
				.environment(store)
				.task {
					PushManager.shared.configure(store: store)
					watchSync.activate(store: store)
					store.start()
					if store.isSignedIn {
						PushManager.shared.requestAuthorizationAndRegister()
					}
				}
				.onChange(of: store.isSignedIn) { _, signedIn in
					guard signedIn else { return }
					watchSync.sync()
					PushManager.shared.requestAuthorizationAndRegister()
				}
		}
	}
}
