import SwiftUI
import DeckKit
import DeckUI

/// The PR reviewer panel, opened from the Sessions screen. A review whose PR a
/// session captured opens that session; any other opens on GitHub.
struct ReviewsView: View {
	@Environment(DeckStore.self) private var store
	@Environment(\.dismiss) private var dismiss
	@Environment(\.openURL) private var openURL
	let openSession: (String) -> Void

	var body: some View {
		NavigationStack {
			List {
				if let reviews = store.reviews {
					ReviewsPanel(reviews: reviews) { repo, pr, url in open(repo: repo, pr: pr, url: url) }
				} else {
					ProgressView()
				}
			}
			.navigationTitle("Reviews")
			.navigationBarTitleDisplayMode(.inline)
			.refreshable { await store.refreshReviews() }
			.toolbar {
				ToolbarItem(placement: .confirmationAction) {
					Button("Done") { dismiss() }
				}
			}
		}
		// The reviewer has no event of its own, so poll while this is open.
		.task {
			while !Task.isCancelled {
				await store.refreshReviews()
				try? await Task.sleep(for: .seconds(15))
			}
		}
	}

	private func open(repo: String, pr: Int, url: String) {
		if let session = ReviewMatch.session(repo: repo, pr: pr, in: store.sessions) {
			dismiss()
			openSession(session.id)
		} else if let link = URL(string: url) {
			openURL(link)
		}
	}
}
