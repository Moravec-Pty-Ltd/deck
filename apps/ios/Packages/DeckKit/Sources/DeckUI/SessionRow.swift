import SwiftUI
import DeckKit

/// A session in the sessions list: status, title, project and model, and the
/// chips worth a glance.
public struct SessionRow: View {
	let session: SessionDigest

	public init(session: SessionDigest) {
		self.session = session
	}

	public var body: some View {
		HStack(alignment: .top, spacing: 12) {
			StatusDot(session: session)
				.padding(.top, 6)

			VStack(alignment: .leading, spacing: 4) {
				HStack(spacing: 4) {
					Text(title)
						.font(.body.weight(session.unread == true ? .semibold : .medium))
						.lineLimit(1)
					if session.watches?.isEmpty == false {
						Image(systemName: "timer")
							.font(.caption)
							.foregroundStyle(.secondary)
							.accessibilityLabel("Waiting on a watch")
					}
				}

				HStack(spacing: 4) {
					if let project = projectName {
						Text(project).foregroundStyle(.primary)
						Text("·")
					}
					Text(session.kind ?? "claude")
					if let model = session.model, !model.isEmpty {
						Text("· \(model)")
					}
				}
				.font(.caption)
				.foregroundStyle(.secondary)
				.lineLimit(1)

				if hasChips {
					ScrollView(.horizontal, showsIndicators: false) {
						HStack(spacing: 6) {
							if session.awaitingInput == true {
								Chip(text: "needs you", color: .orange)
							}
							if let pr = session.pr, pr.number != nil {
								PRStatusBadge(pr: pr)
							}
							if let costText = CostFormat.string(session.cost?.costUsd) {
								Chip(text: costText)
							}
							// Only once the window is worth noticing: a chip on
							// every row saying "4%" is noise.
							if let context = session.context, context.percent >= 66 {
								Chip(
									text: "context \(context.percent)%",
									color: context.percent >= 85 ? .red : .orange)
							}
						}
					}
				}
			}

			Spacer(minLength: 8)

			Text(RelativeFormat.string(session.lastActiveAt))
				.font(.caption2)
				.foregroundStyle(.secondary)
		}
		.padding(.vertical, 4)
	}

	private var hasChips: Bool {
		session.awaitingInput == true || session.pr?.number != nil || session.cost?.costUsd != nil
			|| (session.context?.percent ?? 0) >= 66
	}

	private var title: String {
		if let title = session.title, !title.isEmpty { return title }
		if let cwd = session.cwd, let last = cwd.split(separator: "/").last { return String(last) }
		return session.id
	}

	private var projectName: String? {
		if let repo = session.worktree?.repo, let last = repo.split(separator: "/").last { return String(last) }
		if let cwd = session.cwd, let last = cwd.split(separator: "/").last { return String(last) }
		return nil
	}
}
