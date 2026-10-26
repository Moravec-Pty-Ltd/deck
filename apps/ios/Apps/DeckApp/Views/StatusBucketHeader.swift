import SwiftUI
import DeckKit

/// A status group's section header: its colour dot and name, as the web's.
struct StatusBucketHeader: View {
	@Environment(DeckStore.self) private var store
	let bucket: SessionGrouping.Bucket
	/// The ids "Mark all read" clears; the button only shows on Unread.
	var unreadIds: [String] = []

	var body: some View {
		HStack(spacing: 6) {
			Group {
				switch bucket {
				case .unread: Circle().fill(.teal)
				case .needsAttention: Circle().fill(.red)
				case .active: Circle().fill(Color.accentColor)
				case .justFinished: Circle().fill(.green)
				case .idle: Circle().fill(.secondary)
				case .dead: Circle().stroke(.secondary, lineWidth: 1.5)
				}
			}
			.frame(width: 8, height: 8)
			Text(bucket.label)
			if bucket == .unread {
				Spacer()
				Button("Mark all read") { Task { try? await store.markRead(unreadIds) } }
					.font(.caption)
					.buttonStyle(.borderless)
			}
		}
	}
}
