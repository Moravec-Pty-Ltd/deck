import SwiftUI
import DeckKit

@main
struct DeckWatchMain: App {
	@WKApplicationDelegateAdaptor(WatchPushDelegate.self) private var appDelegate
	@State private var phoneSync: PhoneSync?
	@Environment(\.scenePhase) private var scenePhase

	private var store: DeckStore { appDelegate.store }

	var body: some Scene {
		WindowGroup {
			WatchRootView()
				.environment(store)
				.environment(appDelegate.router)
				.task {
					if phoneSync == nil {
						let sync = PhoneSync(store: store)
						sync.activate()
						phoneSync = sync
					}
				}
				.onChange(of: store.isSignedIn) { _, isSignedIn in
					if isSignedIn { appDelegate.requestPushRegistration() }
				}
				.onChange(of: scenePhase) { _, phase in
					guard store.isSignedIn else { return }
					if phase == .active {
						store.start()
					} else {
						store.stopEventLoop()
					}
				}
		}
	}
}
