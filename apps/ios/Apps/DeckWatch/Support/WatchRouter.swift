import SwiftUI
import DeckKit

/// Top-level tabs on the watch: Inbox (asks), Start (kick off work), Sessions
/// (monitor), Operator (talk to deck).
enum WatchTab: Hashable {
	case inbox, start, sessions, voiceOperator
}

/// Shared navigation state for the single root NavigationStack. Kept at the App
/// level (not inside WatchRootView) so the push-notification delegate can jump
/// to Inbox from outside the view hierarchy.
@MainActor
@Observable
final class WatchRouter {
	var tab: WatchTab = .inbox
	var path = NavigationPath()
	/// A session to open once it appears in the store (e.g. from a notification
	/// tap on cold launch, before the session list has loaded).
	var pendingSessionId: String?

	func popToRoot() {
		path = NavigationPath()
	}

	/// Used after a notification tap or after answering a question: land on a
	/// clean top-level tab, not mid-stack.
	func show(_ tab: WatchTab) {
		popToRoot()
		self.tab = tab
	}

	/// Open a specific session (from a notification). Lands on the Sessions tab
	/// and drills into the session once it is available.
	func openSession(_ id: String) {
		popToRoot()
		tab = .sessions
		pendingSessionId = id
	}
}

/// Push target for a session's voice screen, distinct from the session
/// itself so both can sit on the same stack.
struct VoiceRoute: Hashable {
	let session: SessionDigest
}
