import SwiftUI
import DeckKit

/// Top-level tabs on the watch: Inbox (asks), Start (kick off work), Sessions
/// (monitor), Operator (talk to deck).
enum WatchTab: Hashable {
	case inbox, start, sessions, voiceOperator
}

/// Shared navigation state for the single root NavigationStack. Owned by the
/// push-notification delegate (not WatchRootView) so a notification tap can
/// route before any view exists.
@MainActor
@Observable
final class WatchRouter {
	var tab: WatchTab = .inbox
	var path = NavigationPath()
	/// The session the latest notification tap asked for, so a slower earlier
	/// tap doesn't push over it.
	private var opening: String?

	func popToRoot() {
		path = NavigationPath()
	}

	/// Used after a notification tap or after answering a question: land on a
	/// clean top-level tab, not mid-stack.
	func show(_ tab: WatchTab) {
		popToRoot()
		self.tab = tab
	}

	/// Open a specific session (from a notification). Refetches the list when
	/// the session is newer than it, and falls back to the Inbox when deck
	/// doesn't know the session.
	func openSession(_ id: String, in store: DeckStore) async {
		show(.sessions)
		opening = id
		defer { if opening == id { opening = nil } }
		// A tap that wakes the watch can beat its network, so retry a failed fetch.
		var fetched = store.sessions.contains { $0.id == id }
		for attempt in 0..<3 where !fetched {
			if attempt > 0 { try? await Task.sleep(for: .seconds(2)) }
			fetched = await store.refreshSessions()
		}
		// The user moved on, or a newer tap took over.
		guard opening == id, tab == .sessions, path.isEmpty else { return }
		if let session = store.sessions.first(where: { $0.id == id }) {
			path.append(session)
		} else if fetched {
			show(.inbox)
		}
	}
}

/// Push target for a session's voice screen, distinct from the session
/// itself so both can sit on the same stack.
struct VoiceRoute: Hashable {
	let session: SessionDigest
}
