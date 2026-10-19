import SwiftUI
import DeckKit

/// What removing a project does, said wherever the app offers it.
enum ProjectRemoval {
	static let message = "deck stops listing it. Its folder, worktrees and sessions are left as they are."
}

/// The registered projects, grouped as the session list groups them, each
/// opening its editor. `editorExtra` adds the app's own sections to the editor
/// (automation, for one) below the shared fields.
public struct ProjectsManagerView<Extra: View>: View {
	@Environment(DeckStore.self) private var store
	private let editorExtra: (DeckProject) -> Extra
	@State private var showAdd = false
	@State private var removing: DeckProject?
	@State private var errorMessage: String?

	public init(@ViewBuilder editorExtra: @escaping (DeckProject) -> Extra) {
		self.editorExtra = editorExtra
	}

	public var body: some View {
		List {
			if let errorMessage {
				Section { Text(errorMessage).foregroundStyle(.red).font(.footnote) }
			}
			ForEach(ProjectGroups.grouped(store.projects)) { entry in
				Section(entry.name) {
					ForEach(entry.projects) { project in
						NavigationLink(value: project) { ProjectRowLabel(project: project) }
							.swipeActions(edge: .trailing, allowsFullSwipe: false) { swipeActions(project) }
					}
				}
			}
		}
		.overlay {
			if store.projects.isEmpty {
				ContentUnavailableView(
					"No projects", systemImage: "folder",
					description: Text("Add a folder or clone a repo to start sessions in it."))
			}
		}
		.safeAreaInset(edge: .top, spacing: 0) {
			ServerTooOldBanner(needs: [.projectConfig, .projectsWrite, .clone, .fsComplete])
		}
		.navigationTitle("Projects")
		.toolbar {
			if store.supports(.projectsWrite) {
				ToolbarItem(placement: .primaryAction) {
					Button { showAdd = true } label: { Label("Add project", systemImage: "plus") }
						.accessibilityIdentifier("addProject")
				}
			}
		}
		.navigationDestination(for: DeckProject.self) { project in
			ProjectEditorForm(project: project) { editorExtra(project) }
		}
		.sheet(isPresented: $showAdd) {
			NavigationStack { AddProjectForm() }
		}
		.confirmationDialog(
			"Remove \(removing?.name ?? "project")?",
			isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
			titleVisibility: .visible,
			presenting: removing
		) { project in
			Button("Remove", role: .destructive) { Task { await remove(project) } }
			Button("Cancel", role: .cancel) {}
		} message: { _ in
			Text(ProjectRemoval.message)
		}
		.task {
			await store.refreshProjects()
			await store.refreshProjectDetails()
		}
	}

	@ViewBuilder
	private func swipeActions(_ project: DeckProject) -> some View {
		if store.supports(.projectsWrite) {
			Button(role: .destructive) { removing = project } label: { Label("Remove", systemImage: "trash") }
		}
		// Hiding takes the project's sessions out of the session list with it;
		// nothing stops running.
		let hide = project.hidden != true
		Button {
			Task { try? await store.setHidden(projectPath: project.path, hidden: hide) }
		} label: {
			Label(hide ? "Hide" : "Unhide", systemImage: hide ? "eye.slash" : "eye")
		}
		.tint(.gray)
	}

	private func remove(_ project: DeckProject) async {
		errorMessage = nil
		do {
			try await store.removeProject(path: project.path)
		} catch {
			errorMessage = DeckError.message(for: error)
		}
	}
}

struct ProjectRowLabel: View {
	let project: DeckProject
	@Environment(DeckStore.self) private var store

	var body: some View {
		VStack(alignment: .leading, spacing: 2) {
			Text(project.name)
			Text(project.path)
				.font(.caption)
				.foregroundStyle(.secondary)
				.lineLimit(1)
				.truncationMode(.head)
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

/// One project's name, group and first-prompt templates, saved as a PATCH of
/// only what changed, plus removing it.
public struct ProjectEditorForm<Extra: View>: View {
	let project: DeckProject
	private let extra: Extra

	@Environment(DeckStore.self) private var store
	@Environment(\.dismiss) private var dismiss
	@State private var draft = ProjectDraft()
	@State private var original = ProjectDraft()
	@State private var loaded = false
	@State private var isSaving = false
	@State private var errorMessage: String?
	@State private var confirmRemove = false

	public init(project: DeckProject, @ViewBuilder extra: () -> Extra) {
		self.project = project
		self.extra = extra()
	}

	private var changes: [String: String] { draft.changes(from: original) }

	public var body: some View {
		Form {
			if store.supports(.projectConfig) {
				fields
			} else {
				Section { LabeledContent("Folder", value: project.path) }
			}
			extra
			IssueSourcesLink(project: project)
			if let errorMessage {
				Section { Text(errorMessage).foregroundStyle(.red).font(.footnote) }
			}
			if store.supports(.projectsWrite) {
				Section {
					Button("Remove project", role: .destructive) { confirmRemove = true }
						.accessibilityIdentifier("removeProject")
				} footer: {
					Text(ProjectRemoval.message)
				}
			}
		}
		.navigationTitle(store.projectDetails[project.path]?.name ?? project.name)
		.deckInlineNavigationTitle()
		.toolbar {
			if store.supports(.projectConfig) {
				ToolbarItem(placement: .confirmationAction) {
					Button(isSaving ? "Saving…" : "Save") { Task { await save() } }
						.disabled(!loaded || isSaving || changes.isEmpty)
				}
			}
		}
		.confirmationDialog("Remove \(project.name)?", isPresented: $confirmRemove, titleVisibility: .visible) {
			Button("Remove", role: .destructive) { Task { await remove() } }
			Button("Cancel", role: .cancel) {}
		} message: {
			Text(ProjectRemoval.message)
		}
		.task { await load() }
	}

	@ViewBuilder
	private var fields: some View {
		Section("Project") {
			TextField("Name", text: $draft.name)
				.deckPlainInput()
			GroupField(group: $draft.group)
			LabeledContent("Folder") {
				Text(project.path)
					.font(.caption.monospaced())
					.lineLimit(1)
					.truncationMode(.head)
			}
			NavigationLink("Dev servers") { DevConfigEditor(project: project) }
		}
		Section {
			TextField("Default first prompt (optional)", text: $draft.template, axis: .vertical)
				.lineLimit(3...12)
		} header: {
			Text("Work sessions")
		} footer: {
			Text("Placeholders: [title] [branch-name] [base-branch] [cwd] [issue_id] [issue_url] [issue_title] [issue_body] [issue_comments]")
		}
		Section {
			TextField("Review first prompt (optional)", text: $draft.reviewPrompt, axis: .vertical)
				.lineLimit(3...12)
		} header: {
			Text("Review sessions")
		} footer: {
			Text("Review sessions also get [pr_number] [pr_title] [pr_branch] [pr_base] [pr_url].")
		}
	}

	private func load() async {
		// Once: coming back from a pushed screen keeps unsaved edits.
		guard !loaded else { return }
		if store.supports(.projectConfig), store.projectDetails[project.path] == nil {
			await store.refreshProjectDetails()
		}
		original = ProjectDraft(project: project, detail: store.projectDetails[project.path])
		draft = original
		loaded = true
	}

	private func save() async {
		isSaving = true
		errorMessage = nil
		do {
			try await store.updateProject(path: project.path, changes: changes)
			original = ProjectDraft(project: project, detail: store.projectDetails[project.path])
			draft = original
		} catch {
			errorMessage = DeckError.message(for: error)
		}
		isSaving = false
	}

	private func remove() async {
		errorMessage = nil
		do {
			try await store.removeProject(path: project.path)
			dismiss()
		} catch {
			errorMessage = DeckError.message(for: error)
		}
	}
}

/// Register an existing folder, or clone a repo into a parent folder.
public struct AddProjectForm: View {
	private enum Mode { case folder, clone }

	@Environment(DeckStore.self) private var store
	@Environment(\.dismiss) private var dismiss
	@State private var mode = Mode.folder
	@State private var url = ""
	@State private var path = ""
	@State private var name = ""
	@State private var nameEdited = false
	@State private var group: String
	@State private var isAdding = false
	@State private var errorMessage: String?

	public init(group: String = "") {
		_group = State(initialValue: group)
	}

	private var cloning: Bool { mode == .clone }
	private var destination: String? { RepoURL.destination(parent: path, url: url) }
	private var canAdd: Bool {
		!isAdding && !path.trimmingCharacters(in: .whitespaces).isEmpty && (!cloning || RepoURL.isSafe(url))
	}

	public var body: some View {
		Form {
			if store.supports(.clone) {
				Picker("Source", selection: $mode) {
					Text("Existing folder").tag(Mode.folder)
					Text("Clone a repo").tag(Mode.clone)
				}
				.pickerStyle(.segmented)
				.onChange(of: mode) { autofillName() }
			}
			if cloning {
				Section {
					TextField("https://github.com/acme/repo.git", text: $url)
						.deckPlainInput()
						.onChange(of: url) { autofillName() }
				} header: {
					Text("Repo URL")
				} footer: {
					if !url.isEmpty, !RepoURL.isSafe(url) {
						Text("Use an https, ssh, git or scp-style url.")
					}
				}
			}
			Section {
				PathField(path: $path)
			} header: {
				Text(cloning ? "Parent folder" : "Folder")
			} footer: {
				if cloning, let destination {
					Text("Clones into \(destination)")
				}
			}
			Section("Details") {
				TextField("Name (defaults to the folder name)", text: Binding(
					get: { name },
					set: { name = $0; nameEdited = true }))
				GroupField(group: $group)
			}
			if let errorMessage {
				Section { Text(errorMessage).foregroundStyle(.red).font(.footnote) }
			}
		}
		.navigationTitle("Add project")
		.deckInlineNavigationTitle()
		.toolbar {
			ToolbarItem(placement: .cancellationAction) {
				Button("Cancel") { dismiss() }
			}
			ToolbarItem(placement: .confirmationAction) {
				Button(addLabel) { Task { await add() } }
					.disabled(!canAdd)
					.accessibilityIdentifier("confirmAddProject")
			}
		}
		.interactiveDismissDisabled(isAdding)
	}

	private var addLabel: String {
		if isAdding { return cloning ? "Cloning…" : "Adding…" }
		return cloning ? "Clone" : "Add"
	}

	/// The repo's name fills the name field until the user types their own.
	private func autofillName() {
		guard !nameEdited else { return }
		name = cloning && RepoURL.isSafe(url) ? RepoURL.name(from: url) ?? "" : ""
	}

	private func add() async {
		isAdding = true
		errorMessage = nil
		do {
			if cloning {
				try await store.cloneProject(url: url, parent: path, name: name, group: group)
			} else {
				try await store.registerProject(path: path, name: name, group: group)
			}
			dismiss()
		} catch {
			errorMessage = DeckError.message(for: error)
		}
		isAdding = false
	}
}

/// A folder path with the server's directory suggestions under it. Picking
/// one fills it in and lists what is inside, as the web PathInput does.
struct PathField: View {
	@Binding var path: String
	@Environment(DeckStore.self) private var store
	@State private var query = ""
	@State private var suggestions: [String] = []

	var body: some View {
		TextField("~/code/example", text: Binding(
			get: { path },
			set: { path = $0; query = $0 }))
			.deckPlainInput()
			.font(.body.monospaced())
			.task(id: query) { await suggest() }
		ForEach(PathCompletion.visible(suggestions, typed: path).prefix(8), id: \.self) { suggestion in
			Button {
				path = suggestion
				query = PathCompletion.drillIn(suggestion)
			} label: {
				Label(suggestion, systemImage: "folder")
					.font(.caption.monospaced())
					.lineLimit(1)
					.truncationMode(.head)
			}
		}
	}

	private func suggest() async {
		guard store.supports(.fsComplete), !query.isEmpty, let client = store.client else {
			suggestions = []
			return
		}
		try? await Task.sleep(for: .milliseconds(150))
		guard !Task.isCancelled, let list = try? await client.completePath(query), !Task.isCancelled else { return }
		suggestions = list
	}
}

/// A group name, with the groups already in use one tap away.
struct GroupField: View {
	@Binding var group: String
	@Environment(DeckStore.self) private var store

	private var existing: [String] {
		Set(store.projects.compactMap(\.group).filter { !$0.isEmpty }).sorted()
	}

	var body: some View {
		HStack {
			TextField("Group (optional)", text: $group)
				.deckPlainInput()
			if !existing.isEmpty {
				Menu {
					ForEach(existing, id: \.self) { name in
						Button(name) { group = name }
					}
				} label: {
					Image(systemName: "chevron.up.chevron.down")
				}
				.accessibilityLabel("Existing groups")
			}
		}
	}
}
