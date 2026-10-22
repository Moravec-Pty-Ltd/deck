import SwiftUI
import DeckKit

/// The PR on one line: state-coloured icon, number, title, then the review
/// verdict with its marks and whether it can merge.
public struct PRSummary: View {
	let pr: SessionPR

	public init(pr: SessionPR) {
		self.pr = pr
	}

	public var body: some View {
		HStack(spacing: 6) {
			Image(systemName: "arrow.triangle.pull")
				.foregroundStyle(PRDisplay.color(for: pr))
			Text(pr.number.map { "#\($0)" } ?? "PR")
				.font(.subheadline.weight(.semibold))
			if let title = pr.title {
				Text(title)
					.font(.subheadline)
					.lineLimit(1)
					.truncationMode(.tail)
					.layoutPriority(-1)
			}
			Spacer(minLength: 4)
			if let verdict = PRDisplay.verdict(for: pr) {
				Text(verdict.label)
					.font(.caption)
					.foregroundStyle(verdict.color)
					.lineLimit(1)
			}
			ReviewMarks(approvals: pr.approvals ?? 0, changesRequested: pr.changesRequested ?? 0)
			if let readiness = PRDisplay.readiness(for: pr) {
				Chip(text: readiness.label, color: readiness.color)
			}
		}
		.foregroundStyle(.primary)
	}
}

/// The PR's actions, as menu items in the row's menu and as buttons on the
/// tabletop's flat half.
public struct PRActions: View {
	let pr: SessionPR
	var canMerge: Bool
	var onReview: () -> Void
	var onMerge: () -> Void
	/// Nil when the server cannot dismiss a PR.
	var onDismiss: (() -> Void)?

	public init(
		pr: SessionPR,
		canMerge: Bool,
		onReview: @escaping () -> Void,
		onMerge: @escaping () -> Void,
		onDismiss: (() -> Void)?
	) {
		self.pr = pr
		self.canMerge = canMerge
		self.onReview = onReview
		self.onMerge = onMerge
		self.onDismiss = onDismiss
	}

	public var body: some View {
		if let link = pr.url.flatMap(URL.init(string:)) {
			Link(destination: link) {
				Label("Open in browser", systemImage: "safari")
			}
		}
		Button("Review…", systemImage: "text.bubble", action: onReview)
			.accessibilityIdentifier("prReview")
		if canMerge {
			Button(PRDisplay.isBlocked(pr) ? "Force merge…" : "Merge…", systemImage: "arrow.triangle.merge", action: onMerge)
		}
		if let onDismiss {
			Button("Dismiss", systemImage: "xmark", role: .destructive, action: onDismiss)
				.accessibilityIdentifier("prDismiss")
		}
	}
}

/// The PR header: the summary opens the actions menu, and a ready PR of your
/// own gets a Merge button so the last step stays one tap.
public struct PRHeaderRow: View {
	let pr: SessionPR
	var canMerge: Bool
	var onReview: () -> Void
	var onMerge: () -> Void
	var onDismiss: (() -> Void)?

	public init(
		pr: SessionPR,
		canMerge: Bool,
		onReview: @escaping () -> Void,
		onMerge: @escaping () -> Void,
		onDismiss: (() -> Void)?
	) {
		self.pr = pr
		self.canMerge = canMerge
		self.onReview = onReview
		self.onMerge = onMerge
		self.onDismiss = onDismiss
	}

	public var body: some View {
		HStack(spacing: 8) {
			Menu {
				PRActions(pr: pr, canMerge: canMerge, onReview: onReview, onMerge: onMerge, onDismiss: onDismiss)
			} label: {
				PRSummary(pr: pr).contentShape(Rectangle())
			}
			.menuStyle(.button)
			.buttonStyle(.plain)
			.accessibilityIdentifier("prRow")
			// A blocked PR force-merges past branch protection: menu only, never one tap.
			if canMerge, !PRDisplay.isBlocked(pr) {
				Button("Merge", action: onMerge)
					.buttonStyle(.borderedProminent)
					.controlSize(.small)
					.accessibilityIdentifier("prMerge")
			}
		}
	}
}

/// Approve, request changes or comment, with the web's message rule: a
/// message is optional only to approve. Outside a review session it only
/// comments.
public struct ReviewSheet: View {
	let allowsVerdict: Bool
	var onSubmit: (_ decision: String, _ body: String?) -> Void

	@Environment(\.dismiss) private var dismiss
	@State private var decision: String
	@State private var text = ""

	public init(allowsVerdict: Bool, onSubmit: @escaping (_ decision: String, _ body: String?) -> Void) {
		self.allowsVerdict = allowsVerdict
		self.onSubmit = onSubmit
		_decision = State(initialValue: allowsVerdict ? "approve" : "comment")
	}

	private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

	public var body: some View {
		NavigationStack {
			VStack(spacing: 12) {
				if allowsVerdict {
					Picker("Review", selection: $decision) {
						Text("Approve").tag("approve")
						Text("Request changes").tag("request-changes")
						Text("Comment").tag("comment")
					}
					.pickerStyle(.segmented)
				}
				TextEditor(text: $text)
					.overlay(alignment: .topLeading) {
						if text.isEmpty {
							Text(decision == "approve" ? "Optional message" : "Message")
								.foregroundStyle(.tertiary)
								.padding(.top, 8)
								.padding(.leading, 5)
								.allowsHitTesting(false)
						}
					}
			}
			.padding()
			.navigationTitle(allowsVerdict ? "Review" : "Comment")
			.deckInlineNavigationTitle()
			.toolbar {
				ToolbarItem(placement: .cancellationAction) {
					Button("Cancel") { dismiss() }
				}
				ToolbarItem(placement: .confirmationAction) {
					Button("Submit") {
						onSubmit(decision, trimmed.isEmpty ? nil : text)
						dismiss()
					}
					.disabled(decision != "approve" && trimmed.isEmpty)
				}
			}
		}
	}
}
