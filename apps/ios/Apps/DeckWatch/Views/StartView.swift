import SwiftUI
import DeckKit

/// StartTarget carries everything the confirmation screen and the create call
/// need, so ProjectStartView doesn't have to thread separate optionals.
enum StartTarget: Hashable {
	case issue(DeckIssue, DeckProject)
	case pr(DeckPR, DeckProject)
}

struct StartView: View {
	@Environment(DeckStore.self) private var store

	var body: some View {
		Group {
			if store.projects.isEmpty {
				ProgressView()
			} else {
				List(store.projects) { project in
					NavigationLink(value: project) {
						VStack(alignment: .leading, spacing: 2) {
							Text(project.name).font(.headline)
							if let group = project.group {
								Text(group).font(.caption2).foregroundStyle(.secondary)
							}
						}
					}
				}
			}
		}
		.navigationTitle("Start")
		.task { await store.refreshProjects() }
		.refreshable { await store.refreshProjects() }
	}
}
