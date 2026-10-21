import SwiftUI
import DeckKit
import DeckUI

/// Settings > Projects: the shared project manager, with each project's
/// automation one level down from its editor.
struct ProjectsSettingsView: View {
	@Environment(DeckStore.self) private var store

	var body: some View {
		ProjectsManagerView { project in
			if store.supports(.projectConfig) {
				Section {
					NavigationLink("Automation") { ProjectAutomationView(project: project) }
				} footer: {
					Text("Start sessions on their own for new issues and PRs.")
				}
			}
		}
		.task { await store.refreshKinds() }
	}
}
