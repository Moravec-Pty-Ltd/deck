import SwiftUI
import DeckKit

/// Root: pairing gate, then a single NavigationStack hosting a vertical
/// TabView (Inbox / Start / Sessions). Destinations are registered once here
/// (not per-tab) so a push works regardless of which tab is currently active
/// -- e.g. jumping from a session's detail screen to an ask that lives under
/// the Inbox tab.
struct WatchRootView: View {
	@Environment(DeckStore.self) private var store
	@Environment(WatchRouter.self) private var router

	var body: some View {
		if store.isSignedIn {
			NavigationStack(path: Bindable(router).path) {
				TabView(selection: Bindable(router).tab) {
					InboxView().tag(WatchTab.inbox)
					SessionsView().tag(WatchTab.sessions)
					StartView().tag(WatchTab.start)
					OperatorView().tag(WatchTab.voiceOperator)
				}
				.tabViewStyle(.verticalPage)
				.navigationDestination(for: DeckAsk.self) { AskDetailView(ask: $0) }
				.navigationDestination(for: DeckProject.self) { ProjectStartView(project: $0) }
				.navigationDestination(for: StartTarget.self) { StartConfirmationView(target: $0) }
				.navigationDestination(for: SessionDigest.self) { SessionDetailView(session: $0) }
				.navigationDestination(for: VoiceRoute.self) { VoiceView(session: $0.session) }
			}
			.onChange(of: store.sessions) { _, _ in resolvePendingSession() }
			.onChange(of: router.pendingSessionId) { _, _ in resolvePendingSession() }
		} else {
			PairingView()
		}
	}

	/// Once the session named by a notification tap is in the store, drill into it.
	private func resolvePendingSession() {
		guard let id = router.pendingSessionId,
			let session = store.sessions.first(where: { $0.id == id }) else { return }
		router.path.append(session)
		router.pendingSessionId = nil
	}
}
