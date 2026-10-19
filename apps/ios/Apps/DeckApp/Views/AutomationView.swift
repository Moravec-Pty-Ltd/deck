import SwiftUI
import DeckKit
import DeckUI

/// Per-project feed automation (the web Projects page's automation section):
/// whether new issues assigned to you and PRs awaiting your review spawn a
/// session on their own, and what each lane spawns with.
struct ProjectAutomationView: View {
	let project: DeckProject

	@Environment(DeckStore.self) private var store
	@Environment(\.dismiss) private var dismiss

	@State private var work = false
	@State private var review = false
	@State private var workAgent = AutomationAgent()
	@State private var reviewAgent = AutomationAgent()
	@State private var loaded = false
	@State private var isSaving = false
	@State private var errorMessage: String?

	var body: some View {
		Form {
			Section {
				Toggle("Work on new issues", isOn: $work)
				Toggle("Review new PRs", isOn: $review)
			} header: {
				Text("Automation")
			} footer: {
				Text("When on, deck starts a session for each new issue assigned to you (work) or PR awaiting your review (review). Each item fires once.")
			}

			if work {
				AutomationAgentSection(title: "Work lane agent", agent: $workAgent)
			}
			if review {
				AutomationAgentSection(title: "Review lane agent", agent: $reviewAgent)
			}

			if let errorMessage {
				Section {
					Text(errorMessage).foregroundStyle(.red).font(.footnote)
				}
			}
		}
		.navigationTitle(project.name)
		.navigationBarTitleDisplayMode(.inline)
		.toolbar {
			ToolbarItem(placement: .confirmationAction) {
				Button(isSaving ? "Saving…" : "Save") {
					Task { await save() }
				}
				.disabled(isSaving || !loaded)
			}
		}
		.task { await load() }
	}

	private func load() async {
		if store.projectDetails[project.path] == nil { await store.refreshProjectDetails() }
		let automation = store.projectDetails[project.path]?.automation
		work = automation?.work ?? false
		review = automation?.review ?? false
		workAgent = automation?.workAgent ?? AutomationAgent()
		reviewAgent = automation?.reviewAgent ?? AutomationAgent()
		loaded = true
	}

	private func save() async {
		isSaving = true
		errorMessage = nil
		do {
			try await store.saveAutomation(
				projectPath: project.path,
				automation: ProjectAutomation(work: work, review: review, workAgent: workAgent, reviewAgent: reviewAgent))
			dismiss()
		} catch {
			errorMessage = error.localizedDescription
		}
		isSaving = false
	}
}

/// One automation lane's agent: kind, model, pi's provider, claude's effort.
/// Blank fields fall back to the project's remembered pick, as on the web.
struct AutomationAgentSection: View {
	let title: String
	@Binding var agent: AutomationAgent

	@Environment(DeckStore.self) private var store

	private var kinds: [String] {
		let available = store.kinds.filter { $0.available && $0.kind != "shell" }.map(\.kind)
		let current = agent.kind ?? "claude"
		return available.contains(current) ? available : [current] + available
	}

	private var kind: String { agent.kind ?? "claude" }

	var body: some View {
		Section(title) {
			Picker("Kind", selection: Binding(
				get: { kind },
				set: { newKind in
					// Fields that belong to another kind can't linger, or the
					// server rejects the save.
					agent = AutomationAgent(
						kind: newKind,
						model: nil,
						provider: newKind == "pi" ? agent.provider : nil,
						effort: newKind == "claude" ? agent.effort : nil)
				})) {
				ForEach(kinds, id: \.self) { Text($0).tag($0) }
			}
			if kind == "pi" {
				TextField("Provider (optional)", text: Binding(
					get: { agent.provider ?? "" },
					set: { agent.provider = $0.isEmpty ? nil : $0 }))
					.textInputAutocapitalization(.never)
					.autocorrectionDisabled()
			}
			let models = store.knownModels(for: kind)
			if models.isEmpty {
				TextField("Model (optional)", text: Binding(
					get: { agent.model ?? "" },
					set: { agent.model = $0.isEmpty ? nil : $0 }))
					.textInputAutocapitalization(.never)
					.autocorrectionDisabled()
			} else {
				Picker("Model", selection: Binding(
					get: { agent.model ?? "" },
					set: { agent.model = $0.isEmpty ? nil : $0 })) {
					Text("Project default").tag("")
					ForEach(models, id: \.self) { Text($0).tag($0) }
				}
			}
			if kind == "claude" {
				Picker("Thinking", selection: Binding(
					get: { agent.effort ?? "" },
					set: { agent.effort = $0.isEmpty ? nil : $0 })) {
					Text("Project default").tag("")
					ForEach(DeckEffort.levels, id: \.self) { Text($0.capitalized).tag($0) }
				}
			}
		}
	}
}

/// The registered projects, each leading to its automation settings.
struct ProjectsSettingsView: View {
	@Environment(DeckStore.self) private var store

	var body: some View {
		List {
			ForEach(ProjectGroups.grouped(store.projects)) { entry in
				Section(entry.name) {
					ForEach(entry.projects) { project in
						Group {
							// Automation lives on the project config route; a deck
							// without it lists the projects with nowhere to go.
							if store.supports(.projectConfig) {
								NavigationLink(value: project) { row(project) }
							} else {
								row(project)
							}
						}
						// Hiding takes the project's sessions out of the session
						// list with it; nothing stops running.
						.swipeActions(edge: .trailing, allowsFullSwipe: false) {
							let hide = project.hidden != true
							Button {
								Task { try? await store.setHidden(projectPath: project.path, hidden: hide) }
							} label: {
								Label(hide ? "Hide" : "Unhide", systemImage: hide ? "eye.slash" : "eye")
							}
							.tint(.gray)
						}
					}
				}
			}
		}
		.safeAreaInset(edge: .top, spacing: 0) { ServerTooOldBanner(needs: [.projectConfig]) }
		.navigationTitle("Projects")
		.navigationDestination(for: DeckProject.self) { project in
			ProjectAutomationView(project: project)
		}
		.task {
			await store.refreshProjects()
			await store.refreshProjectDetails()
			await store.refreshKinds()
		}
	}

	private func row(_ project: DeckProject) -> some View {
		VStack(alignment: .leading, spacing: 2) {
			Text(project.name)
			HStack(spacing: 6) {
				Text(project.path)
					.font(.caption)
					.foregroundStyle(.secondary)
					.lineLimit(1)
					.truncationMode(.head)
			}
			if let automation = store.projectDetails[project.path]?.automation,
				automation.work == true || automation.review == true {
				HStack(spacing: 4) {
					if automation.work == true { Chip(text: "auto work", color: .blue) }
					if automation.review == true { Chip(text: "auto review", color: .purple) }
				}
			}
		}
	}

}
