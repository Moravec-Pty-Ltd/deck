import SwiftUI
import DeckKit

struct RootView: View {
	@Environment(DeckStore.self) private var store
	@Environment(\.scenePhase) private var scenePhase
	@State private var hinge = HingeMonitor()

	var body: some View {
		Group {
			if store.isSignedIn {
				MainTabView()
			} else {
				SignInView()
			}
		}
		.environment(hinge)
		.background {
			GeometryReader { geometry in
				HingeObserver(monitor: hinge)
					.frame(width: 0, height: 0)
					.onChange(of: geometry.size, initial: true) { _, size in hinge.windowSize = size }
			}
			// Only the container inset: ignoring every region would include the
			// keyboard, and a root that ignores that stops lifting the composer.
			.ignoresSafeArea(.container)
		}
		.onChange(of: scenePhase) { _, phase in
			switch phase {
			case .active:
				store.start()
				ActivityManager.shared.configure(client: store.client)
				ActivityManager.shared.reconcile(with: store.sessions)
			case .background: store.stopEventLoop()
			default: break
			}
		}
		// A Live Activity tap opens its session (deck://s/<id>).
		.onOpenURL { url in
			guard url.scheme == "deck", let id = DeckLink.sessionId(from: url) else { return }
			NotificationCenter.default.post(name: .deckOpenSession, object: id)
		}
		// Sessions that start running while the app is open get a card; the
		// store's live feed keeps existing cards current.
		.onChange(of: store.sessions) { old, sessions in
			ActivityManager.shared.configure(client: store.client)
			let wasRunning = Set(old.filter { $0.status == .running }.map(\.id))
			for session in sessions {
				if session.status == .running, !wasRunning.contains(session.id) { ActivityManager.shared.start(session) }
				else { ActivityManager.shared.update(session) }
			}
		}
	}
}

struct MainTabView: View {
	enum Tab: Hashable {
		case sessions, inbox, voiceOperator, start, browser
	}

	@Environment(DeckStore.self) private var store
	@State private var selectedTab: Tab = .sessions
	@State private var deepLinkSessionId: String?
	@State private var deepLinkRunId: String?

	var body: some View {
		TabView(selection: $selectedTab) {
			SessionsView(deepLinkSessionId: $deepLinkSessionId)
				.tabItem { Label("Sessions", systemImage: "list.bullet.rectangle") }
				.tag(Tab.sessions)

			InboxView(deepLinkRunId: $deepLinkRunId)
				.tabItem { Label("Inbox", systemImage: "tray") }
				.badge(store.awaitingCount)
				.tag(Tab.inbox)

			OperatorView()
				.tabItem { Label("Operator", systemImage: "waveform") }
				.tag(Tab.voiceOperator)

			StartView { sessionId in
				deepLinkSessionId = sessionId
				selectedTab = .sessions
			}
			.tabItem { Label("Start", systemImage: "plus.circle") }
			.tag(Tab.start)

			NavigationStack { BrowserView() }
				.tabItem { Label("Browser", systemImage: "globe") }
				.tag(Tab.browser)
		}
		.onReceive(NotificationCenter.default.publisher(for: .deckOpenSession)) { note in
			guard let sessionId = note.object as? String else { return }
			deepLinkSessionId = sessionId
			selectedTab = .sessions
		}
		.onReceive(NotificationCenter.default.publisher(for: .deckOpenRun)) { note in
			guard let runId = note.object as? String else { return }
			deepLinkRunId = runId
			selectedTab = .inbox
		}
	}
}
