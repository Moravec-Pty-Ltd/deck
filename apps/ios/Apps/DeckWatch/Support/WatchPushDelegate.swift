import WatchKit
import UserNotifications
import DeckKit

/// App-level delegate (wired via @WKApplicationDelegateAdaptor in
/// DeckWatchMain): requests notification authorization + APNs registration
/// once signed in, and routes a notification tap to its session or the Inbox.
/// Owns the store and router so a tap that cold-launches the app can route
/// before any view has appeared.
@MainActor
final class WatchPushDelegate: NSObject, WKApplicationDelegate {
	let store = DeckStore()
	let router = WatchRouter()

	private var didRequestAuthorization = false

	func applicationDidFinishLaunching() {
		UNUserNotificationCenter.current().delegate = self
	}

	func requestPushRegistration() {
		guard !didRequestAuthorization else { return }
		didRequestAuthorization = true
		Task {
			do {
				let granted = try await UNUserNotificationCenter.current()
					.requestAuthorization(options: [.alert, .sound, .badge])
				guard granted else { return }
				WKApplication.shared().registerForRemoteNotifications()
			} catch {
				didRequestAuthorization = false
			}
		}
	}

	func didRegisterForRemoteNotifications(withDeviceToken deviceToken: Data) {
		guard let client = store.client else { return }
		let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
		Task {
			#if DEBUG
			let env = "development"
			#else
			let env = "production"
			#endif
			try? await client.registerAPNs(token: hex, platform: "watchos", env: env)
		}
	}

	func didFailToRegisterForRemoteNotificationsWithError(_ error: Error) {
		didRequestAuthorization = false
	}
}

extension WatchPushDelegate: UNUserNotificationCenterDelegate {
	func userNotificationCenter(
		_ center: UNUserNotificationCenter,
		didReceive response: UNNotificationResponse
	) async {
		let userInfo = response.notification.request.content.userInfo
		if let url = userInfo["url"] as? String, let id = DeckLink.sessionId(from: url) {
			// Don't hold the tap response open for a network fetch.
			Task { await router.openSession(id, in: store) }
		} else {
			router.show(.inbox)
		}
	}

	nonisolated func userNotificationCenter(
		_ center: UNUserNotificationCenter,
		willPresent notification: UNNotification
	) async -> UNNotificationPresentationOptions {
		[.banner, .sound]
	}
}
