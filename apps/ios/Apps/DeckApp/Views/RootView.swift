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
	enum Destination: Hashable {
		case sessions, inbox, voiceOperator, start, browser, settings
	}

	@Environment(DeckStore.self) private var store
	@Environment(\.horizontalSizeClass) private var sizeClass
	@State private var selectedTab: Destination = .sessions
	@State private var deepLinkSessionId: String?
	@State private var deepLinkRunId: String?

	/// With a sidebar to hold it, the gear opens the Settings tab. A phone's
	/// tab bar has no room for a sixth tab (iOS buries it under "More"), so
	/// there Settings stays out of the bar and the gear pushes it instead.
	private var openSettingsTab: (() -> Void)? {
		sizeClass == .regular ? { selectedTab = .settings } : nil
	}

	var body: some View {
		TabView(selection: $selectedTab) {
			Tab("Sessions", systemImage: "list.bullet.rectangle", value: .sessions) {
				SessionsView(deepLinkSessionId: $deepLinkSessionId, openSettingsTab: openSettingsTab)
			}

			Tab("Inbox", systemImage: "tray", value: .inbox) {
				InboxView(deepLinkRunId: $deepLinkRunId)
			}
			.badge(store.awaitingCount)

			Tab("Operator", systemImage: "waveform", value: .voiceOperator) {
				OperatorView()
			}

			Tab("Start", systemImage: "plus.circle", value: .start) {
				StartView { sessionId in
					deepLinkSessionId = sessionId
					selectedTab = .sessions
				}
			}

			Tab("Browser", systemImage: "globe", value: .browser) {
				NavigationStack { BrowserView() }
			}

			Tab("Settings", systemImage: "gearshape", value: .settings) {
				NavigationStack { SettingsView() }
			}
			.defaultVisibility(.hidden, for: .tabBar)
		}
		.tabViewStyle(.sidebarAdaptable)
		.modifier(PairingPrompt())
		// Narrowing to compact while on Settings would leave no tab selected.
		.onChange(of: sizeClass) { _, size in
			if size == .compact, selectedTab == .settings { selectedTab = .sessions }
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
