import AppKit
import Observation
import UserNotifications
import DeckKit

final class MacAppDelegate: NSObject, NSApplicationDelegate {
	func applicationDidFinishLaunching(_ notification: Notification) {
		// Set before launch finishes so a launch by a notification's action is caught.
		UNUserNotificationCenter.current().delegate = MacPushManager.shared
		AskNotification.registerCategories()
	}

	func application(_ application: NSApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
		Task { @MainActor in
			MacPushManager.shared.didRegister(deviceToken: deviceToken)
		}
	}

	func application(_ application: NSApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
		#if DEBUG
		print("deck: APNs registration failed: \(error)")
		#endif
	}
}

/// Registers this Mac for deck's pushes once the server says it takes macOS
/// devices, and answers or opens from a notification the way the phone does.
@MainActor
final class MacPushManager: NSObject, UNUserNotificationCenterDelegate {
	static let shared = MacPushManager()

	private weak var store: DeckStore?
	private var registered = false

	private override init() { super.init() }

	func configure(store: DeckStore) {
		guard self.store !== store else { return }
		self.store = store
		follow()
	}

	/// Re-checks on every sign-in and server answer, since the capability is
	/// only known once GET /api/agent has replied.
	private func follow() {
		guard let store else { return }
		withObservationTracking {
			_ = store.isSignedIn
			_ = store.serverInfo
		} onChange: {
			Task { @MainActor in self.follow() }
		}
		registerIfReady()
	}

	private func registerIfReady() {
		guard let store, store.isSignedIn else {
			registered = false
			return
		}
		// Strict: an older deck turns a macos device away, so wait for it to say.
		guard !registered, store.serverInfo?.supports(.apnsMacos) == true else { return }
		registered = true
		Task {
			let center = UNUserNotificationCenter.current()
			let granted = (try? await center.requestAuthorization(options: [.alert, .badge, .sound])) ?? false
			guard granted else { return }
			NSApplication.shared.registerForRemoteNotifications()
		}
	}

	func didRegister(deviceToken: Data) {
		let token = deviceToken.map { String(format: "%02x", $0) }.joined()
		Task {
			guard let client = store?.client else { return }
			#if DEBUG
			let env = "development"
			#else
			let env = "production"
			#endif
			try? await client.registerAPNs(token: token, platform: "macos", env: env)
		}
	}

	// MARK: - UNUserNotificationCenterDelegate

	nonisolated func userNotificationCenter(
		_ center: UNUserNotificationCenter,
		willPresent notification: UNNotification,
		withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
	) {
		completionHandler([.banner, .sound, .badge, .list])
	}

	nonisolated func userNotificationCenter(
		_ center: UNUserNotificationCenter,
		didReceive response: UNNotificationResponse,
		withCompletionHandler completionHandler: @escaping () -> Void
	) {
		let userInfo = response.notification.request.content.userInfo
		let url = userInfo["url"] as? String
		let answer = AskNotification.answer(for: response)
		let target = AskNotification.target(userInfo: userInfo)
		Task { @MainActor in
			if let answer {
				// Answered from the banner: post it and leave the app where it was.
				await AskNotification.post(answer, client: self.store?.client, url: url)
			} else if let target {
				self.open(target)
			}
			completionHandler()
		}
	}

	private func open(_ target: AskNotification.Target) {
		switch target {
		case .session(let id):
			MacOpener.open(session: id)
		case .run(let runId):
			// The Mac has no runs board: open the run's phase session when it has one.
			let ask = store?.asks.first { $0.runId == runId && $0.sessionId != runId }
			if let ask {
				MacOpener.open(session: ask.sessionId)
			} else {
				MacOpener.showMain()
			}
		}
	}
}
