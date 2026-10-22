import SwiftUI
import DeckKit

/// A status group's section header: its colour dot and name, as the web's.
struct StatusBucketHeader: View {
	let bucket: SessionGrouping.Bucket

	var body: some View {
		HStack(spacing: 6) {
			Group {
				switch bucket {
				case .needsAttention: Circle().fill(.red)
				case .active: Circle().fill(Color.accentColor)
				case .justFinished: Circle().fill(.green)
				case .idle: Circle().fill(.secondary)
				case .dead: Circle().stroke(.secondary, lineWidth: 1.5)
				}
			}
			.frame(width: 8, height: 8)
			Text(bucket.label)
		}
	}
}
