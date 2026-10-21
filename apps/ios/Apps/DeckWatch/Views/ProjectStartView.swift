import SwiftUI
import DeckKit

struct ProjectStartView: View {
	@Environment(DeckStore.self) private var store
	let project: DeckProject

	private enum ListTab: String, CaseIterable, Identifiable {
		case issues = "Issues"
		case prs = "PRs"
		var id: String { rawValue }
	}

	@State private var section: ListTab = .issues

	private var issues: [DeckIssue] { store.issuesByProject[project.path] ?? [] }
	private var prs: [DeckPR] { store.prsByProject[project.path] ?? [] }

	var body: some View {
		List {
			Section {
				sectionToggle
					.listRowBackground(Color.clear)
			}
			switch section {
			case .issues: issueRows
			case .prs: prRows
			}
		}
		.navigationTitle(project.name)
		.task {
			await store.refreshIssues(project: project.path)
			await store.refreshPRs(project: project.path)
		}
	}

	private var sectionToggle: some View {
		HStack(spacing: 4) {
			ForEach(ListTab.allCases) { candidate in
				Button {
					section = candidate
				} label: {
					Text(candidate.rawValue)
						.font(.caption)
						.frame(maxWidth: .infinity)
				}
				.buttonStyle(.bordered)
				.tint(section == candidate ? .accentColor : .gray)
			}
		}
	}

	@ViewBuilder
	private var issueRows: some View {
		if issues.isEmpty {
			Text("No open issues").foregroundStyle(.secondary)
		} else {
			ForEach(issues) { issue in
				NavigationLink(value: StartTarget.issue(issue, project)) {
					VStack(alignment: .leading, spacing: 2) {
						Text(issue.shortId).font(.caption2).foregroundStyle(.secondary)
						Text(issue.title ?? issue.shortId).font(.body).lineLimit(2)
					}
				}
			}
		}
	}

	@ViewBuilder
	private var prRows: some View {
		if prs.isEmpty {
			Text("No open PRs").foregroundStyle(.secondary)
		} else {
			ForEach(prs) { pr in
				NavigationLink(value: StartTarget.pr(pr, project)) {
					VStack(alignment: .leading, spacing: 2) {
						Text("#\(pr.number)" + (pr.author.map { " · \($0)" } ?? ""))
							.font(.caption2)
							.foregroundStyle(.secondary)
						Text(pr.title ?? "PR #\(pr.number)").font(.body).lineLimit(2)
					}
				}
			}
		}
	}
}
