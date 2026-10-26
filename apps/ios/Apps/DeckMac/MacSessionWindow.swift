import SwiftUI
import DeckKit

/// The session window most recently in front, for Start's default project.
@MainActor enum MacFrontSession {
	static var id: String?
}

/// A session in a window of its own. It follows a rename to the new id, and
/// closes once the session is deleted.
struct MacSessionWindow: View {
	let sessionId: String?
	@Environment(DeckStore.self) private var store
	@Environment(\.dismiss) private var dismiss
	@Environment(\.appearsActive) private var appearsActive
	@State private var current: String?

	var body: some View {
		Group {
			if !store.isSignedIn {
				ContentUnavailableView("Not signed in", systemImage: "person.crop.circle.badge.questionmark")
			} else if let id = current ?? sessionId {
				NavigationStack {
					MacSessionDetail(sessionId: id, onIdChanged: { current = $0 }, onDeleted: { dismiss() })
				}
				.id(id)
			} else {
				ContentUnavailableView("No session", systemImage: "bubble.left.and.text.bubble.right")
			}
		}
		.onChange(of: appearsActive, initial: true) { _, active in
			if active { MacFrontSession.id = current ?? sessionId }
		}
		.onChange(of: current) { _, id in
			if appearsActive { MacFrontSession.id = id ?? sessionId }
		}
		.onDisappear {
			if MacFrontSession.id == current ?? sessionId { MacFrontSession.id = nil }
		}
	}
}
