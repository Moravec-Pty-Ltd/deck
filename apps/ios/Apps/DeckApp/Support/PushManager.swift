import Foundation
import UIKit
import UserNotifications
import DeckKit

/// Owns notification authorization/registration and hands the APNs device
/// token to deck's push registration endpoint (a deck-specific extension to
/// the agent API, not part of DeckKit's core client surface it doesn't wrap).
@MainActor
final class PushManager: NSObject, UNUserNotificationCenterDelegate {
	static let shared = PushManager()

	private weak var store: DeckStore?

	private override init() { super.init() }

	func configure(store: DeckStore) {
		self.store = store
		AskNotification.registerCategories()
	}

	func requestAuthorizationAndRegister() {
		Task {
			let center = UNUserNotificationCenter.current()
			let granted = (try? await center.requestAuthorization(options: [.alert, .badge, .sound])) ?? false
			guard granted else { return }
			UIApplication.shared.registerForRemoteNotifications()
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
			try? await client.registerAPNs(token: token, platform: "ios", env: env)
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
		if let answer = AskNotification.answer(for: response) {
			// Answering from the notification: post it and stay out of the way.
			// UIKit requires the completion on the main thread.
			let url = userInfo["url"] as? String
			Task { @MainActor in
				await AskNotification.post(answer, client: self.store?.client, url: url)
				completionHandler()
			}
			return
		}
		switch AskNotification.target(userInfo: userInfo) {
		case .run(let runId):
			Task { @MainActor in
				NotificationCenter.default.post(name: .deckOpenRun, object: runId)
			}
		case .session(let sessionId):
			Task { @MainActor in
				NotificationCenter.default.post(name: .deckOpenSession, object: sessionId)
			}
		case nil:
			break
		}
		completionHandler()
	}
}
