import WatchKit
import UserNotifications
import DeckKit

/// App-level delegate (wired via @WKApplicationDelegateAdaptor in
/// DeckWatchMain): requests notification authorization + APNs registration
/// once signed in, and routes a notification tap to the Inbox.
@MainActor
final class WatchPushDelegate: NSObject, WKApplicationDelegate {
	var store: DeckStore?
	var router: WatchRouter?

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
		guard let client = store?.client else { return }
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
		if let id = Self.sessionId(from: userInfo) {
			router?.openSession(id)
		} else {
			router?.show(.inbox)
		}
	}

	/// Extract a session id from the notification's deep-link url (e.g. "/s/c_1").
	static func sessionId(from userInfo: [AnyHashable: Any]) -> String? {
		guard let url = userInfo["url"] as? String,
			let range = url.range(of: "/s/") else { return nil }
		return url[range.upperBound...].split(separator: "/").first.map(String.init)
	}

	nonisolated func userNotificationCenter(
		_ center: UNUserNotificationCenter,
		willPresent notification: UNNotification
	) async -> UNNotificationPresentationOptions {
		[.banner, .sound]
	}
}
