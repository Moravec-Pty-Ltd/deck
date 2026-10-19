import Foundation
import UIKit
import UserNotifications
import DeckKit

extension Notification.Name {
	static let deckOpenSession = Notification.Name("deck.openSession")
	static let deckOpenRun = Notification.Name("deck.openRun")
}

/// Owns notification authorization/registration and hands the APNs device
/// token to deck's push registration endpoint (a deck-specific extension to
/// the agent API, not part of DeckKit's core client surface it doesn't wrap).
@MainActor
final class PushManager: NSObject, UNUserNotificationCenterDelegate {
	static let shared = PushManager()

	private weak var store: DeckStore?

	private override init() { super.init() }

	nonisolated static let askCategory = "DECK_ASK"
	nonisolated static let optionSlots = 3
	nonisolated static let replyAction = "DECK_ASK_REPLY"

	func configure(store: DeckStore) {
		self.store = store
		registerCategories()
	}

	// Notification actions are registered ahead of time with fixed titles, so a
	// question's options ride as numbered slots; the notification body lists
	// which label each number is. "Reply" takes free text.
	private func registerCategories() {
		let options = (0..<Self.optionSlots).map { i in
			UNNotificationAction(identifier: "DECK_ASK_OPTION_\(i)", title: "Option \(i + 1)", options: [])
		}
		let reply = UNTextInputNotificationAction(
			identifier: Self.replyAction, title: "Reply", options: [],
			textInputButtonTitle: "Send", textInputPlaceholder: "Your answer")
		let ask = UNNotificationCategory(
			identifier: Self.askCategory, actions: options + [reply], intentIdentifiers: [],
			options: [.customDismissAction])
		UNUserNotificationCenter.current().setNotificationCategories([ask])
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
		if let answer = Self.answer(for: response) {
			// Answering from the notification: post it and stay out of the way.
			// UIKit requires the completion on the main thread.
			let url = userInfo["url"] as? String
			Task { @MainActor in
				await self.post(answer, url: url)
				completionHandler()
			}
			return
		}
		if let urlString = userInfo["url"] as? String {
			if let runId = Self.extractRunId(from: urlString) {
				Task { @MainActor in
					NotificationCenter.default.post(name: .deckOpenRun, object: runId)
				}
			} else if let sessionId = Self.extractSessionId(from: urlString) {
				Task { @MainActor in
					NotificationCenter.default.post(name: .deckOpenSession, object: sessionId)
				}
			}
		}
		completionHandler()
	}

	/// What an ask action answers with; nil for a plain tap or a non-ask
	/// notification.
	nonisolated static func answer(for response: UNNotificationResponse) -> NotificationAnswer? {
		let content = response.notification.request.content
		guard content.categoryIdentifier == askCategory else { return nil }
		return NotificationAnswer(
			userInfo: content.userInfo, optionSlot: optionSlot(response.actionIdentifier),
			typed: (response as? UNTextInputNotificationResponse)?.userText)
	}

	nonisolated private static func optionSlot(_ actionIdentifier: String) -> Int? {
		let prefix = "DECK_ASK_OPTION_"
		guard actionIdentifier.hasPrefix(prefix) else { return nil }
		return Int(actionIdentifier.dropFirst(prefix.count))
	}

	/// Post the answer the way the ask card does, so the transcript shows it
	/// answered with the pick. The signed-in store's client serves when the app
	/// is alive; the keychain covers a launch in the background just for this.
	/// A failed post raises an "Answer not sent" notification, since the user
	/// never sees the app and would otherwise think the question was answered.
	private func post(_ answer: NotificationAnswer, url: String?) async {
		do {
			guard let client = store?.client ?? CredentialStore.load().map({ DeckClient(credentials: $0) }) else {
				throw DeckError.notConfigured
			}
			if let runId = answer.runId {
				// A run hands the reply to its next phase session as written.
				_ = try await client.runAction(id: runId, .answer, text: answer.label)
				return
			}
			guard let sessionId = answer.sessionId else { return }
			let text = "Answering your question:\n- \(answer.header): \(answer.label)"
			let answers = answer.structured ? [StructuredAnswer(header: answer.header, labels: [answer.label])] : []
			_ = try await client.answer(sessionId: sessionId, text: text, askId: answer.askId, answers: answers)
		} catch {
			let content = UNMutableNotificationContent()
			content.title = "Answer not sent"
			if case DeckError.http(_, let message) = error {
				// deck's own reason, e.g. a 409 for a run that is no longer blocked.
				content.body = "\"\(answer.label)\": \(message)"
			} else {
				content.body = "\"\(answer.label)\": \(error.localizedDescription)"
			}
			// Tapping opens the run or session to answer there.
			if let url { content.userInfo = ["url": url] }
			let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
			try? await UNUserNotificationCenter.current().add(request)
		}
	}

	/// Pulls `<id>` out of a run URL's `/runs/<id>` path, which deck sends when
	/// a workflow run blocks or finishes.
	nonisolated static func extractRunId(from urlString: String) -> String? {
		guard let components = URLComponents(string: urlString) else { return nil }
		let parts = components.path.split(separator: "/").map(String.init)
		guard let index = parts.firstIndex(of: "runs"), parts.indices.contains(index + 1) else { return nil }
		return parts[index + 1]
	}

	/// Pulls `<id>` out of a session URL's `/s/<id>` path, e.g.
	/// `http://localhost:4818/s/c_abc123`.
	nonisolated static func extractSessionId(from urlString: String) -> String? {
		guard let components = URLComponents(string: urlString) else { return nil }
		let parts = components.path.split(separator: "/").map(String.init)
		guard let index = parts.firstIndex(of: "s"), parts.indices.contains(index + 1) else { return nil }
		return parts[index + 1]
	}
}
