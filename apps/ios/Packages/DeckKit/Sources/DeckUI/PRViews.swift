import SwiftUI
import DeckKit

public struct PRSection: View {
	let pr: SessionPR
	var canMerge: Bool
	var onApprove: () -> Void
	var onRequestChanges: () -> Void
	var onComment: () -> Void
	var onMerge: () -> Void

	public init(
		pr: SessionPR,
		canMerge: Bool,
		onApprove: @escaping () -> Void,
		onRequestChanges: @escaping () -> Void,
		onComment: @escaping () -> Void,
		onMerge: @escaping () -> Void
	) {
		self.pr = pr
		self.canMerge = canMerge
		self.onApprove = onApprove
		self.onRequestChanges = onRequestChanges
		self.onComment = onComment
		self.onMerge = onMerge
	}

	public var body: some View {
		VStack(alignment: .leading, spacing: 8) {
			HStack(spacing: 6) {
				Image(systemName: "arrow.triangle.pull")
				if let repo = pr.repo {
					Text(repo).font(.caption).foregroundStyle(.secondary)
				}
				PRStatusBadge(pr: pr)
				Spacer()
			}

			HStack(spacing: 8) {
				Button("Approve", action: onApprove)
				Button("Request changes", action: onRequestChanges)
				Button("Comment", action: onComment)
			}
			.buttonStyle(.bordered)
			.font(.caption)

			// Merge is only for your own PR; on a review session (someone else's
			// PR) it is hidden, matching deck's own-PR guard.
			if canMerge {
				Button {
					onMerge()
				} label: {
					Label("Merge", systemImage: "arrow.triangle.merge")
						.frame(maxWidth: .infinity)
				}
				.buttonStyle(.borderedProminent)
				.disabled(pr.state?.lowercased() != "open")
			}
		}
	}
}

public struct CommentSheet: View {
	let title: String
	@Binding var text: String
	var onSubmit: () -> Void

	public init(title: String, text: Binding<String>, onSubmit: @escaping () -> Void) {
		self.title = title
		_text = text
		self.onSubmit = onSubmit
	}

	@Environment(\.dismiss) private var dismiss

	public var body: some View {
		NavigationStack {
			TextEditor(text: $text)
				.padding()
				.navigationTitle(title)
				.deckInlineNavigationTitle()
				.toolbar {
					ToolbarItem(placement: .cancellationAction) {
						Button("Cancel") { dismiss() }
					}
					ToolbarItem(placement: .confirmationAction) {
						Button("Submit") {
							onSubmit()
							dismiss()
						}
						.disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
					}
				}
		}
	}
}
