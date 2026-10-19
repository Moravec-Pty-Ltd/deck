#if canImport(ActivityKit) && !targetEnvironment(macCatalyst)
import ActivityKit
#endif
import Foundation
import DeckKit

/// Starts a Live Activity for a running session and keeps deck able to update
/// it: the activity's push token is registered with deck, which pushes status,
/// cost, and the newest reply until the session finishes. Local updates from
/// the store's event loop keep the card current while the app is open.
@MainActor
final class ActivityManager {
	static let shared = ActivityManager()
	private var tokenTasks: [String: Task<Void, Never>] = [:]
	private var client: DeckClient?

	private init() {}

	func configure(client: DeckClient?) {
		self.client = client
	}

#if canImport(ActivityKit) && !targetEnvironment(macCatalyst)

	/// Debug builds get sandbox tokens, the same split as device registration.
	private var pushEnvironment: String {
		#if DEBUG
		"development"
		#else
		"production"
		#endif
	}

	private func activity(for sessionId: String) -> Activity<SessionActivityAttributes>? {
		Activity<SessionActivityAttributes>.activities.first { $0.attributes.sessionId == sessionId }
	}

	/// Begin showing a session, unless a card for it already exists. A new
	/// activity's push token is handed to deck as soon as (and whenever) it lands.
	func start(_ session: SessionDigest) {
		guard ActivityAuthorizationInfo().areActivitiesEnabled, activity(for: session.id) == nil else { return }
		let startedMs = session.lastActiveAt ?? Date().timeIntervalSince1970 * 1000
		let attributes = SessionActivityAttributes(
			sessionId: session.id,
			title: session.title ?? session.id,
			startedAt: Date(timeIntervalSince1970: startedMs / 1000))
		let content = ActivityContent(state: state(for: session, lastText: ""), staleDate: nil)
		do {
			watchTokens(try Activity.request(attributes: attributes, content: content, pushType: .token))
		} catch {
			// No push entitlement (an unsigned build): the card still works from
			// the store's live feed while the app is open.
			_ = try? Activity.request(attributes: attributes, content: content, pushType: nil)
		}
	}

	private func watchTokens(_ activity: Activity<SessionActivityAttributes>) {
		let sessionId = activity.attributes.sessionId
		tokenTasks[sessionId]?.cancel()
		tokenTasks[sessionId] = Task { [weak self] in
			for await data in activity.pushTokenUpdates {
				let token = data.map { String(format: "%02x", $0) }.joined()
				guard let self, let client = self.client else { continue }
				try? await client.registerActivity(sessionId: sessionId, token: token, env: self.pushEnvironment)
			}
		}
		Task { [weak self] in
			for await state in activity.activityStateUpdates where state == .dismissed || state == .ended {
				self?.tokenTasks[sessionId]?.cancel()
				self?.tokenTasks[sessionId] = nil
				if let token = activity.pushToken?.map({ String(format: "%02x", $0) }).joined(), let client = self?.client {
					try? await client.unregisterActivity(token: token)
				}
			}
		}
	}

	/// Reflect the store's view of a session (status, cost) on its card at once,
	/// keeping the last reply text deck pushed.
	func update(_ session: SessionDigest) {
		guard let activity = activity(for: session.id) else { return }
		let content = ActivityContent(state: state(for: session, lastText: activity.content.state.lastText), staleDate: nil)
		Task { await activity.update(content) }
	}

	func end(sessionId: String) {
		guard let activity = activity(for: sessionId) else { return }
		Task { await activity.end(nil, dismissalPolicy: .immediate) }
	}

	/// Cards for sessions the store no longer lists are cleared; the rest are
	/// refreshed from the store. Run on foreground.
	func reconcile(with sessions: [SessionDigest]) {
		for activity in Activity<SessionActivityAttributes>.activities {
			guard let session = sessions.first(where: { $0.id == activity.attributes.sessionId }) else {
				end(sessionId: activity.attributes.sessionId)
				continue
			}
			update(session)
		}
	}

	private func state(for session: SessionDigest, lastText: String) -> SessionActivityAttributes.ContentState {
		SessionActivityAttributes.ContentState(
			status: session.status.rawValue,
			awaitingInput: session.awaitingInput ?? false,
			lastText: lastText,
			costUsd: session.cost?.costUsd ?? 0,
			turns: session.cost?.turns ?? 0,
			updatedAt: Date().timeIntervalSince1970 * 1000)
	}
#else
	// Live Activities are a phone and watch thing; on the Mac the calls are
	// simply no-ops so the callers need no platform checks of their own.
	func start(_ session: SessionDigest) {}
	func update(_ session: SessionDigest) {}
	func end(sessionId: String) {}
	func reconcile(with sessions: [SessionDigest]) {}
#endif
}
