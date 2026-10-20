import SwiftUI
import DeckKit

/// The project editor's way into its issue sources, hidden on a deck without them.
struct IssueSourcesLink: View {
	let project: DeckProject
	@Environment(DeckStore.self) private var store

	var body: some View {
		if store.supports(.issueSources) {
			Section {
				NavigationLink { IssueSourcesView(project: project) } label: {
					Label("Issue sources", systemImage: "tray.full")
				}
				.accessibilityIdentifier("issueSources")
			} footer: {
				Text("Where the issue picker finds this project's issues.")
			}
		}
	}
}

/// A project's GitHub, Linear and ClickUp sources, with add and remove.
/// Mirrors the web's IssueSources.svelte.
struct IssueSourcesView: View {
	let project: DeckProject
	@Environment(DeckStore.self) private var store
	@State private var sources: [IssueSource] = []
	@State private var loaded = false
	@State private var errorMessage: String?
	@State private var adding: IssueSourceSetup?

	var body: some View {
		List {
			if let errorMessage {
				Section { Text(errorMessage).foregroundStyle(.red).font(.footnote) }
			}
			Section {
				ForEach(sources) { source in
					IssueSourceRow(source: source) { Task { await remove(source) } }
				}
			} footer: {
				if loaded, sources.isEmpty { Text("No sources yet. Add one to pick this project's issues.") }
			}
		}
		.navigationTitle("Issue sources")
		.deckInlineNavigationTitle()
		.toolbar {
			ToolbarItem(placement: .primaryAction) {
				Menu {
					ForEach(IssueSourceType.allCases) { type in
						Button(type.label) { startAdding(type) }
					}
				} label: {
					Label("Add source", systemImage: "plus")
				}
				.accessibilityIdentifier("addIssueSource")
			}
		}
		.sheet(item: $adding, onDismiss: { Task { await load() } }) { setup in
			NavigationStack { AddIssueSourceForm(setup: setup, projectPath: project.path) }
		}
		.task { await load() }
	}

	private func startAdding(_ type: IssueSourceType) {
		guard let client = store.client else { return }
		let setup = IssueSourceSetup(client: client, type: type)
		adding = setup
		Task { await setup.start() }
	}

	private func load() async {
		guard let client = store.client else { return }
		do {
			sources = try await client.issueSources(projectPath: project.path)
			errorMessage = nil
		} catch {
			errorMessage = DeckError.message(for: error)
		}
		loaded = true
	}

	private func remove(_ source: IssueSource) async {
		guard let client = store.client else { return }
		do {
			try await client.removeIssueSource(projectPath: project.path, id: source.id)
			await load()
		} catch {
			errorMessage = DeckError.message(for: error)
		}
	}
}

private struct IssueSourceRow: View {
	let source: IssueSource
	let onRemove: () -> Void

	var body: some View {
		HStack(spacing: 8) {
			Chip(text: source.kind?.label ?? source.type, color: color)
			Text(source.summary)
				.lineLimit(1)
				.truncationMode(.middle)
			Spacer()
			Button(role: .destructive, action: onRemove) {
				Image(systemName: "trash")
			}
			.buttonStyle(.borderless)
			.accessibilityLabel("Remove source")
		}
	}

	private var color: Color {
		switch source.kind {
		case .github: return .primary
		case .linear: return .indigo
		case .clickup: return .pink
		case nil: return .secondary
		}
	}
}

/// One new source: the key step for Linear and ClickUp, then the provider's
/// cascade. A typed key goes in a SecureField and is held only by `setup`.
struct AddIssueSourceForm: View {
	@Bindable var setup: IssueSourceSetup
	let projectPath: String
	@Environment(\.dismiss) private var dismiss

	var body: some View {
		Form {
			switch setup.type {
			case .github: githubFields
			case .linear, .clickup:
				if setup.connected {
					Section { LabeledContent("Assignee", value: setup.meLabel) }
					if setup.type == .linear { LinearCascade(setup: setup) } else { ClickupCascade(setup: setup) }
				} else {
					keyStep
				}
			}
			if let message = setup.errorMessage {
				Section { Text(message).foregroundStyle(.red).font(.footnote) }
			}
		}
		.navigationTitle("Add \(setup.type.label) source")
		.deckInlineNavigationTitle()
		.toolbar {
			ToolbarItem(placement: .cancellationAction) {
				Button("Cancel") { dismiss() }
			}
			ToolbarItem(placement: .confirmationAction) {
				if setup.busy {
					ProgressView()
				} else {
					Button("Add") { Task { if await setup.save(projectPath: projectPath) { dismiss() } } }
						.disabled(!setup.canSave)
						.accessibilityIdentifier("saveIssueSource")
				}
			}
		}
		.onDisappear { setup.discard() }
	}

	@ViewBuilder
	private var githubFields: some View {
		Section {
			TextField("owner", text: $setup.githubOwner).deckPlainInput()
			TextField("repo", text: $setup.githubRepo).deckPlainInput()
		} footer: {
			Text("Lists open issues assigned to you (via gh). No API key.")
		}
	}

	/// Reusing a saved key is offered first: once a second project is on the
	/// same workspace, that is the common case.
	@ViewBuilder
	private var keyStep: some View {
		Section {
			if !setup.credentials.isEmpty {
				Picker("Key", selection: $setup.credentialId) {
					ForEach(setup.credentials) { credential in
						Text(credential.displayLabel).tag(credential.id)
					}
					Text("Use a different key").tag("")
				}
			}
			if setup.credentialId.isEmpty {
				SecureField("\(setup.type.label) API key", text: $setup.apiKey)
					.deckPlainInput()
					.accessibilityIdentifier("issueSourceKey")
			}
			Button("Connect") { Task { await setup.connect() } }
				.disabled(setup.busy || !setup.hasKey)
		} footer: {
			Text("The key is sent to deck, which keeps it in the server's keyring. It is not saved on this device.")
		}
	}
}

private func selection(_ value: String, _ set: @escaping (String) async -> Void) -> Binding<String> {
	Binding(get: { value }, set: { id in Task { await set(id) } })
}

private struct LinearCascade: View {
	@Bindable var setup: IssueSourceSetup

	var body: some View {
		Section {
			Picker("Team", selection: selection(setup.linearTeamId, setup.selectLinearTeam)) {
				Text("Pick a team").tag("")
				ForEach(setup.linearTeams) { team in
					Text("\(team.name) (\(team.key))").tag(team.id)
				}
			}
		}
		if !setup.linearStates.isEmpty {
			Section("States to list") {
				ForEach(setup.linearStates) { state in
					Toggle(state.name, isOn: Binding(
						get: { setup.linearStateIds.contains(state.id) },
						set: { _ in setup.linearStateIds = IssueSourceSetup.toggled(setup.linearStateIds, state.id) }))
				}
			}
		}
	}
}

private struct ClickupCascade: View {
	@Bindable var setup: IssueSourceSetup

	var body: some View {
		Section {
			Picker("Workspace", selection: selection(setup.place.teamId, setup.selectClickupTeam)) {
				Text("Pick a workspace").tag("")
				ForEach(setup.clickupTeams) { Text($0.name).tag($0.id) }
			}
			if !setup.clickupSpaces.isEmpty {
				Picker("Space", selection: selection(setup.place.spaceId, setup.selectClickupSpace)) {
					Text("Pick a space").tag("")
					ForEach(setup.clickupSpaces) { Text($0.name).tag($0.id) }
				}
			}
			if !setup.place.spaceId.isEmpty, !setup.clickupFolders.isEmpty {
				Picker("Folder", selection: selection(setup.place.folderId, setup.selectClickupFolder)) {
					Text("No folder (lists in the space)").tag("")
					ForEach(setup.clickupFolders) { Text($0.name).tag($0.id) }
				}
			}
			if !setup.place.spaceId.isEmpty, !setup.clickupLists.isEmpty {
				Picker("List", selection: selection(setup.place.listId, setup.selectClickupList)) {
					Text("Pick a list").tag("")
					ForEach(setup.clickupLists) { Text($0.name).tag($0.id) }
				}
			}
		}
		if !setup.clickupStatuses.isEmpty {
			Section("Statuses to list") {
				ForEach(setup.clickupStatuses, id: \.status) { status in
					Toggle(status.status, isOn: Binding(
						get: { setup.clickupSelected.contains(status.status) },
						set: { _ in setup.clickupSelected = IssueSourceSetup.toggled(setup.clickupSelected, status.status) }))
				}
			}
		}
	}
}
