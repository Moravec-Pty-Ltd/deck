import Foundation
#if canImport(UserNotifications) && !os(watchOS)
import UserNotifications
#endif

/// The ask notification's category and actions, shared by the phone and the
/// Mac so both register and read the same ones deck's push names.
public enum AskNotification {
	public static let category = "DECK_ASK"
	/// Notification actions are registered ahead of time with fixed titles, so
	/// a question's options ride as numbered slots; the notification body lists
	/// which label each number is.
	public static let optionSlots = 3
	public static let replyAction = "DECK_ASK_REPLY"
	private static let optionPrefix = "DECK_ASK_OPTION_"

	public static func optionAction(_ slot: Int) -> String { "\(optionPrefix)\(slot)" }

	/// The numbered option an action identifier picks, or nil for any other action.
	public static func optionSlot(_ actionIdentifier: String) -> Int? {
		guard actionIdentifier.hasPrefix(optionPrefix) else { return nil }
		return Int(actionIdentifier.dropFirst(optionPrefix.count))
	}

	/// What tapping a notification opens.
	public enum Target: Equatable, Sendable {
		case session(String)
		case run(String)
	}

	/// Where a push's `url` points: a run's `/runs/<id>` (deck sends it when a
	/// workflow run blocks or finishes) or a session's `/s/<id>`.
	public static func target(userInfo: [AnyHashable: Any]) -> Target? {
		guard let url = userInfo["url"] as? String else { return nil }
		if let runId = runId(from: url) { return .run(runId) }
		return DeckLink.sessionId(from: url).map(Target.session)
	}

	public static func runId(from urlString: String) -> String? {
		guard let components = URLComponents(string: urlString) else { return nil }
		let parts = components.path.split(separator: "/").map(String.init)
		guard let index = parts.firstIndex(of: "runs"), parts.indices.contains(index + 1) else { return nil }
		return parts[index + 1]
	}
}

#if canImport(UserNotifications) && !os(watchOS)
extension AskNotification {
	/// "Option 1" to "Option 3", then "Reply" for free text.
	public static func registerCategories() {
		let options = (0..<optionSlots).map { i in
			UNNotificationAction(identifier: optionAction(i), title: "Option \(i + 1)", options: [])
		}
		let reply = UNTextInputNotificationAction(
			identifier: replyAction, title: "Reply", options: [],
			textInputButtonTitle: "Send", textInputPlaceholder: "Your answer")
		let ask = UNNotificationCategory(
			identifier: category, actions: options + [reply], intentIdentifiers: [],
			options: [.customDismissAction])
		UNUserNotificationCenter.current().setNotificationCategories([ask])
	}

	/// What an ask action answers with; nil for a plain tap or a non-ask
	/// notification.
	public static func answer(for response: UNNotificationResponse) -> NotificationAnswer? {
		let content = response.notification.request.content
		guard content.categoryIdentifier == category else { return nil }
		return NotificationAnswer(
			userInfo: content.userInfo, optionSlot: optionSlot(response.actionIdentifier),
			typed: (response as? UNTextInputNotificationResponse)?.userText)
	}

	/// The app icon badge, kept at the number of unread sessions.
	public static func setBadge(_ count: Int) {
		Task { try? await UNUserNotificationCenter.current().setBadgeCount(count) }
	}

	/// Remove a session's delivered notifications once it is opened, so a read
	/// session leaves nothing behind. Most carry the session id as their thread;
	/// a dev server's thread adds its name, so its `/s/<id>` url matches instead.
	public static func clearDelivered(session id: String) {
		Task {
			let center = UNUserNotificationCenter.current()
			let ids = await center.deliveredNotifications()
				.filter {
					$0.request.content.threadIdentifier == id
						|| target(userInfo: $0.request.content.userInfo) == .session(id)
				}
				.map(\.request.identifier)
			center.removeDeliveredNotifications(withIdentifiers: ids)
		}
	}

	/// Post an answer picked on a notification. The signed-in client serves
	/// when the app is alive; the keychain covers a launch just for this. A
	/// failure raises an "Answer not sent" notification, since the user never
	/// sees the app and would otherwise think the question was answered.
	public static func post(_ answer: NotificationAnswer, client: DeckClient?, url: String?) async {
		do {
			guard let client = client ?? CredentialStore.load().map({ DeckClient(credentials: $0) }) else {
				throw DeckError.notConfigured
			}
			try await answer.post(with: client)
		} catch {
			let content = UNMutableNotificationContent()
			content.title = "Answer not sent"
			content.body = answer.failureBody(for: error)
			// Tapping opens the run or session to answer there.
			if let url { content.userInfo = ["url": url] }
			let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
			try? await UNUserNotificationCenter.current().add(request)
		}
	}
}
#endif
