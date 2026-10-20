import SwiftUI
import DeckKit

/// A session in a window of its own. It follows a rename to the new id, and
/// closes once the session is deleted.
struct MacSessionWindow: View {
	let sessionId: String?
	@Environment(DeckStore.self) private var store
	@Environment(\.dismiss) private var dismiss
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
	}
}
