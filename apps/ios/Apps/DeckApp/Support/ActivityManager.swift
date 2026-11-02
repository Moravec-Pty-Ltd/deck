import ActivityKit
import Foundation
import DeckKit

/// Starts a Live Activity for a running session and keeps deck able to update
/// it: the activity's push token is registered with deck, which pushes status,
/// cost, and the newest reply, then ends the card once the session goes quiet.
/// deck can also start a card by push (push-to-start) while the app is closed;
/// the app adopts it. Local updates from the store's event loop keep the card
/// current while the app is open.
@MainActor
final class ActivityManager {
	static let shared = ActivityManager()
	private var tokenTasks: [String: Task<Void, Never>] = [:]
	private var adopted: Set<String> = []
	/// Cards queued to end, which still read as live until they do.
	private var ending: Set<String> = []
	private var observing = false
	private var client: DeckClient?
	/// The push-to-start token and the last one deck accepted: iOS hands it
	/// over only when it changes, so a failed registration retries from here.
	private var startToken: String?
	private var registeredStartToken: String?

	private init() {}

	func configure(client: DeckClient?) {
		// Another deck (signed in afresh) hasn't seen the token.
		if client !== self.client { registeredStartToken = nil }
		self.client = client
		observe()
		registerStartToken()
	}

	private func registerStartToken() {
		guard let token = startToken, token != registeredStartToken, let client = currentClient else { return }
		registeredStartToken = token
		Task { [weak self] in
			guard let self else { return }
			if (try? await client.registerAPNs(token: token, platform: "activity-start", env: self.pushEnvironment)) == nil,
				self.registeredStartToken == token {
				self.registeredStartToken = nil
			}
		}
	}

	private var currentClient: DeckClient? {
		client ?? CredentialStore.load().map { DeckClient(credentials: $0) }
	}

	/// Hand deck the push-to-start token, and adopt every card iOS starts from
	/// a push. Runs from launch too, since a push start wakes the app in the
	/// background to register the new card's token.
	func observe() {
		guard !observing else { return }
		observing = true
		for activity in Activity<SessionActivityAttributes>.activities where Self.isLive(activity) { adopt(activity) }
		Task { [weak self] in
			for await data in Activity<SessionActivityAttributes>.pushToStartTokenUpdates {
				self?.startToken = data.map { String(format: "%02x", $0) }.joined()
				self?.registerStartToken()
			}
		}
		Task { [weak self] in
			for await activity in Activity<SessionActivityAttributes>.activityUpdates {
				self?.adopt(activity)
			}
		}
	}

	private static func isLive(_ activity: Activity<SessionActivityAttributes>) -> Bool {
		activity.activityState == .active || activity.activityState == .stale
	}

	/// Debug builds get sandbox tokens, the same split as device registration.
	private var pushEnvironment: String {
		#if DEBUG
		"development"
		#else
		"production"
		#endif
	}

	/// The session's live card; one deck ended stays on screen until dismissed
	/// but no longer counts.
	private func activity(for sessionId: String) -> Activity<SessionActivityAttributes>? {
		Activity<SessionActivityAttributes>.activities.first { $0.attributes.sessionId == sessionId && Self.isLive($0) }
	}

	/// Track a new card's token and clear any other card for its session (an
	/// ended one still on screen, or the twin of an app start and a push start
	/// racing), so a session never shows two.
	private func adopt(_ activity: Activity<SessionActivityAttributes>) {
		guard Self.isLive(activity), !ending.contains(activity.id), adopted.insert(activity.id).inserted else { return }
		let sessionId = activity.attributes.sessionId
		for other in Activity<SessionActivityAttributes>.activities where other.id != activity.id && other.attributes.sessionId == sessionId {
			ending.insert(other.id)
			Task { await other.end(nil, dismissalPolicy: .immediate) }
		}
		watchTokens(activity)
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
			adopt(try Activity.request(attributes: attributes, content: content, pushType: .token))
		} catch {
			// No push entitlement (an unsigned build): the card still works from
			// the store's live feed while the app is open.
			if let activity = try? Activity.request(attributes: attributes, content: content, pushType: nil) { adopt(activity) }
		}
	}

	/// Keyed by card, not session: an older card of the session ending must not
	/// stop a newer card's token reaching deck.
	private func watchTokens(_ activity: Activity<SessionActivityAttributes>) {
		let sessionId = activity.attributes.sessionId
		let id = activity.id
		tokenTasks[id]?.cancel()
		tokenTasks[id] = Task { [weak self] in
			for await data in activity.pushTokenUpdates {
				let token = data.map { String(format: "%02x", $0) }.joined()
				guard let self, let client = self.currentClient else { continue }
				try? await client.registerActivity(sessionId: sessionId, token: token, env: self.pushEnvironment)
			}
		}
		Task { [weak self] in
			for await state in activity.activityStateUpdates where state == .dismissed || state == .ended {
				self?.tokenTasks[id]?.cancel()
				self?.tokenTasks[id] = nil
				if let token = activity.pushToken?.map({ String(format: "%02x", $0) }).joined(), let client = self?.currentClient {
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

	/// Cards for sessions the store no longer lists, or that went quiet past
	/// the just-finished window, are cleared; the rest are refreshed from the
	/// store. Run on foreground.
	func reconcile(with sessions: [SessionDigest]) {
		let now = Date()
		for activity in Activity<SessionActivityAttributes>.activities {
			guard let session = sessions.first(where: { $0.id == activity.attributes.sessionId }),
				SessionGrouping.showsActivity(session, now: now)
			else {
				Task { await activity.end(nil, dismissalPolicy: .immediate) }
				continue
			}
			update(session)
		}
	}

	private func state(for session: SessionDigest, lastText: String) -> SessionActivityAttributes.ContentState {
		SessionActivityAttributes.ContentState(
			// Subagents still going read as running, as deck's pushes say.
			status: session.isWorking ? SessionStatus.running.rawValue : session.status.rawValue,
			awaitingInput: session.awaitingInput ?? false,
			lastText: lastText,
			costUsd: session.cost?.costUsd ?? 0,
			turns: session.cost?.turns ?? 0,
			updatedAt: Date().timeIntervalSince1970 * 1000)
	}
}
