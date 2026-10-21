import SwiftUI
import DeckKit

/// The PR reviewer's state as list sections: what it is reviewing now, recent
/// verdicts and recent failures, with an offline hint. Matches the web
/// sidebar's Reviews section. `onOpen` gets the row's repo, PR and GitHub URL;
/// the caller decides whether that opens a session or the browser.
public struct ReviewsPanel: View {
	let reviews: ReviewsSnapshot
	let onOpen: (_ repo: String, _ pr: Int, _ url: String) -> Void

	public init(reviews: ReviewsSnapshot, onOpen: @escaping (_ repo: String, _ pr: Int, _ url: String) -> Void) {
		self.reviews = reviews
		self.onOpen = onOpen
	}

	public var body: some View {
		if reviews.status == .offline {
			Label("The reviewer hasn't reported recently, so this may be out of date.", systemImage: "icloud.slash")
				.font(.footnote)
				.foregroundStyle(.secondary)
				.accessibilityIdentifier("reviewsOffline")
		}
		if let review = reviews.inFlight {
			Section("Reviewing now") {
				HStack(spacing: 8) {
					ProgressView().controlSize(.small)
					Text("\(review.repo)#\(review.pr)").fontWeight(.medium).lineLimit(1)
					Spacer()
					Label(review.phaseLabel, systemImage: "eye")
						.font(.caption)
						.foregroundStyle(.secondary)
				}
			}
		}
		Section("Recent") {
			if reviews.recent.isEmpty {
				Text("No recent reviews.")
					.font(.subheadline)
					.foregroundStyle(.secondary)
			}
			ForEach(reviews.recent) { review in
				Button { onOpen(review.repo, review.pr, review.url) } label: { verdictRow(review) }
					.buttonStyle(.plain)
			}
		}
		if !reviews.recentErrors.isEmpty {
			Section("Failed") {
				ForEach(reviews.recentErrors) { failure in
					Button { onOpen(failure.repo, failure.pr, failure.url) } label: { errorRow(failure) }
						.buttonStyle(.plain)
				}
			}
		}
	}

	private func verdictRow(_ review: RecentReview) -> some View {
		HStack(spacing: 8) {
			Image(systemName: Self.icon(review.decision))
				.foregroundStyle(Self.color(review.decision))
			Text("\(review.repo)#\(review.pr)").lineLimit(1)
			Spacer()
			Text(review.decisionLabel)
				.font(.caption)
				.foregroundStyle(.secondary)
		}
		.contentShape(Rectangle())
	}

	private func errorRow(_ failure: ReviewError) -> some View {
		VStack(alignment: .leading, spacing: 2) {
			HStack {
				Text("\(failure.repo)#\(failure.pr)").fontWeight(.medium).lineLimit(1)
				Spacer()
				Text(failure.phaseLabel).font(.caption).foregroundStyle(.secondary)
			}
			.foregroundStyle(.red)
			Text(failure.message).font(.caption).foregroundStyle(.red.opacity(0.8)).lineLimit(2)
			Text(RelativeFormat.string(failure.failedAtMs)).font(.caption2).foregroundStyle(.secondary)
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.contentShape(Rectangle())
	}

	private static func icon(_ decision: String) -> String {
		switch decision {
		case "APPROVE": return "checkmark.circle"
		case "REQUEST_CHANGES": return "xmark.circle"
		default: return "text.bubble"
		}
	}

	private static func color(_ decision: String) -> Color {
		switch decision {
		case "APPROVE": return .green
		case "REQUEST_CHANGES": return .red
		default: return .secondary
		}
	}
}
