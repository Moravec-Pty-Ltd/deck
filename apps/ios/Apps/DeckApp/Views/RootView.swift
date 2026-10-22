import SwiftUI
import DeckKit
import DeckUI

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
			case .background:
				store.stopEventLoop()
				DraftStore.shared.flush()
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
	@State private var sessionsCommand: SessionsCommand?
	@State private var openSessionId: String?
	@State private var showPalette = false
	/// What the palette picked, run once it has gone so a search field or a
	/// sheet has somewhere to appear.
	@State private var picked: PaletteItem?

	/// With a sidebar to hold it, the gear opens the Settings tab. A phone's
	/// tab bar has no room for a sixth tab (iOS buries it under "More"), so
	/// there Settings stays out of the bar and the gear pushes it instead.
	private var openSettingsTab: (() -> Void)? {
		sizeClass == .regular ? { selectedTab = .settings } : nil
	}

	var body: some View {
		TabView(selection: $selectedTab) {
			Tab("Sessions", systemImage: "list.bullet.rectangle", value: .sessions) {
				SessionsView(
					deepLinkSessionId: $deepLinkSessionId,
					command: $sessionsCommand,
					openSessionId: $openSessionId,
					openSettingsTab: openSettingsTab)
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
		.focusedSceneValue(\.deckScene, DeckSceneActions(
			openPalette: { showPalette = true },
			newSession: { selectedTab = .start },
			focusSearch: { sendToSessions(.focusSearch) },
			previousSession: { sendToSessions(.step(-1)) },
			nextSession: { sendToSessions(.step(1)) }))
		.sheet(isPresented: $showPalette, onDismiss: runPicked) {
			CommandPaletteView(index: paletteIndex) { picked = $0 }
		}
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

	private func sendToSessions(_ command: SessionsCommand) {
		selectedTab = .sessions
		sessionsCommand = command
	}

	private var paletteIndex: PaletteIndex {
		var actions: [PaletteAction] = [.newSession, .searchSessions]
		if let openSessionId, store.sessions.first(where: { $0.id == openSessionId })?.status == .running {
			actions.append(.stopTurn)
		}
		actions += [.previousSession, .nextSession, .inbox, .voiceOperator, .browser, .settings]
		return PaletteIndex(actions: actions, sessions: store.activeSessions)
	}

	private func runPicked() {
		guard let item = picked else { return }
		picked = nil
		switch item {
		case .session(let session):
			deepLinkSessionId = session.id
			selectedTab = .sessions
		case .action(let action):
			perform(action)
		}
	}

	private func perform(_ action: PaletteAction) {
		switch action.id {
		case PaletteAction.newSession.id: selectedTab = .start
		case PaletteAction.searchSessions.id: sendToSessions(.focusSearch)
		case PaletteAction.previousSession.id: sendToSessions(.step(-1))
		case PaletteAction.nextSession.id: sendToSessions(.step(1))
		case PaletteAction.inbox.id: selectedTab = .inbox
		case PaletteAction.voiceOperator.id: selectedTab = .voiceOperator
		case PaletteAction.browser.id: selectedTab = .browser
		case PaletteAction.settings.id: openSettings()
		case PaletteAction.stopTurn.id:
			guard let openSessionId else { return }
			Task { try? await store.stop(sessionId: openSessionId) }
		default: break
		}
	}

	/// Settings is a tab only where there is a sidebar; on a phone it lives
	/// behind the Sessions list's gear.
	private func openSettings() {
		if sizeClass == .regular { selectedTab = .settings } else { sendToSessions(.openSettings) }
	}
}
