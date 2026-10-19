import SwiftUI
import DeckKit

struct StartView: View {
	enum Mode: String, CaseIterable, Identifiable {
		case prompt = "Prompt"
		case issues = "Issues"
		case prs = "PRs"
		var id: String { rawValue }
	}

	var onSessionCreated: (String) -> Void

	@Environment(DeckStore.self) private var store
	@State private var selectedProject: DeckProject?
	@State private var mode: Mode = .issues
	@State private var selectedIssue: DeckIssue?
	@State private var selectedPR: DeckPR?
	@State private var startingPrompt = false

	var body: some View {
		NavigationStack {
			VStack(spacing: 0) {
				if store.projects.isEmpty {
					ContentUnavailableView(
						"No projects",
						systemImage: "folder",
						description: Text("Register a project in deck first."))
				} else {
					Picker("Project", selection: $selectedProject) {
						ForEach(ProjectGroups.grouped(store.projects)) { entry in
							Section(entry.name) {
								ForEach(entry.projects) { project in
									Text(project.name).tag(Optional(project))
								}
							}
						}
					}
					.pickerStyle(.menu)
					.padding(.horizontal)

					Picker("Mode", selection: $mode) {
						ForEach(Mode.allCases) { mode in
							Text(mode.rawValue).tag(mode)
						}
					}
					.pickerStyle(.segmented)
					.padding()

					list
				}
			}
			.navigationTitle("Start")
			// Schedules live here rather than in a tab of their own: a schedule
			// is a start that repeats, and the tab bar is already full at five.
			.toolbar {
				ToolbarItem(placement: .primaryAction) {
					NavigationLink {
						SchedulesView()
					} label: {
						Label("Schedules", systemImage: "clock")
					}
					.accessibilityIdentifier("openSchedules")
				}
			}
			.task { await ensureDefaultProject() }
			.onChange(of: selectedProject) { _, _ in Task { await refresh() } }
			.onChange(of: mode) { _, _ in Task { await refresh() } }
			.sheet(item: $selectedIssue) { issue in
				if let project = selectedProject {
					StartConfirmSheet(kind: .issue(issue), project: project, onCreated: onSessionCreated)
				}
			}
			.sheet(item: $selectedPR) { pr in
				if let project = selectedProject {
					StartConfirmSheet(kind: .pr(pr), project: project, onCreated: onSessionCreated)
				}
			}
			.sheet(isPresented: $startingPrompt) {
				if let project = selectedProject {
					StartConfirmSheet(kind: .prompt, project: project, onCreated: onSessionCreated)
				}
			}
		}
	}

	@ViewBuilder
	private var list: some View {
		if let project = selectedProject {
			List {
				switch mode {
				case .prompt:
					// Work with no issue or PR behind it: just a project and a
					// first message.
					Button {
						startingPrompt = true
					} label: {
						Label("New session in \(project.name)", systemImage: "plus.circle")
					}
					Text("Starts a session on its own branch with whatever you type as the first message.")
						.font(.footnote)
						.foregroundStyle(.secondary)
				case .issues:
					let issues = store.issuesByProject[project.path] ?? []
					if issues.isEmpty {
						Text("No open issues.").foregroundStyle(.secondary)
					}
					ForEach(issues) { issue in
						Button { selectedIssue = issue } label: { IssueRow(issue: issue) }
							.buttonStyle(.plain)
					}
				case .prs:
					let prs = store.prsByProject[project.path] ?? []
					if prs.isEmpty {
						Text("No open PRs.").foregroundStyle(.secondary)
					}
					ForEach(prs) { pr in
						Button { selectedPR = pr } label: { PRRow(pr: pr) }
							.buttonStyle(.plain)
					}
				}
			}
			.listStyle(.plain)
			.refreshable { await refresh(force: true) }
		}
	}

	private func ensureDefaultProject() async {
		// A hidden project is still startable, but it should never be what the
		// picker lands on by itself.
		if selectedProject == nil {
			selectedProject = store.projects.first { $0.hidden != true } ?? store.projects.first
		}
		await refresh()
	}

	private func refresh(force: Bool = false) async {
		guard let project = selectedProject else { return }
		switch mode {
		case .prompt: break
		case .issues: await store.refreshIssues(project: project.path, refresh: force)
		case .prs: await store.refreshPRs(project: project.path)
		}
	}
}

struct IssueRow: View {
	let issue: DeckIssue

	var body: some View {
		VStack(alignment: .leading, spacing: 2) {
			Text(issue.repo.map { "\(issue.shortId) · \($0)" } ?? issue.shortId)
				.font(.caption)
				.foregroundStyle(.secondary)
			Text(issue.title ?? issue.shortId)
				.font(.body)
		}
		.padding(.vertical, 2)
	}
}

struct PRRow: View {
	let pr: DeckPR

	var body: some View {
		VStack(alignment: .leading, spacing: 2) {
			HStack(spacing: 6) {
				Text("#\(pr.number)")
					.font(.caption)
					.foregroundStyle(.secondary)
				if pr.isDraft == true {
					Text("Draft")
						.font(.caption2.weight(.semibold))
						.padding(.horizontal, 6)
						.padding(.vertical, 1)
						.background(Color.gray.opacity(0.2), in: Capsule())
				}
			}
			Text(pr.title ?? "#\(pr.number)")
				.font(.body)
			if let author = pr.author {
				Text(author)
					.font(.caption)
					.foregroundStyle(.secondary)
			}
		}
		.padding(.vertical, 2)
	}
}

enum StartTarget {
	/// A session with no issue or PR behind it.
	case prompt
	case issue(DeckIssue)
	case pr(DeckPR)
}

enum StartWorktreeMode: Hashable {
	case newBranch
	case existing
	case none
}

struct StartConfirmSheet: View {
	let kind: StartTarget
	let project: DeckProject
	var onCreated: (String) -> Void

	@Environment(DeckStore.self) private var store
	@Environment(\.dismiss) private var dismiss

	@State private var firstPrompt = ""
	@State private var additionalIssueIds: Set<String> = []
	@State private var agentKind = "claude"
	@State private var model = ""
	@State private var customModel = ""
	@State private var provider = ""
	@State private var effort = ""
	@State private var yolo = true
	@State private var title = ""
	@State private var worktreeMode: StartWorktreeMode = .newBranch
	@State private var branchName = ""
	@State private var branchDirty = false
	@State private var baseBranch = ""
	@State private var branches: [String] = []
	@State private var worktrees: [WorktreeEntry] = []
	@State private var existingWorktree = ""
	@State private var isSubmitting = false
	@State private var idempotencyKey = UUID().uuidString
	@State private var errorMessage: String?

	private var isReview: Bool { if case .pr = kind { return true }; return false }

	private var availableKinds: [String] {
		let kinds = store.kinds.filter { $0.available && $0.kind != "shell" }.map(\.kind)
		return kinds.isEmpty ? ["claude"] : kinds
	}

	private var knownModels: [String] {
		// Delegates so the claude picker picks up locally-configured model
		// profiles alongside the built-in shortnames (see DeckStore.knownModels).
		store.knownModels(for: agentKind)
	}

	private var tokens: [String] { isReview ? DeckPlaceholders.review : DeckPlaceholders.work }

	/// Base branches to offer: the repo's branches, plus the remembered base if
	/// it isn't among them (a remote-only ref still works for `git worktree add`).
	private var baseChoices: [String] {
		baseBranch.isEmpty || branches.contains(baseBranch) ? branches : [baseBranch] + branches
	}

	/// The branch a new worktree gets: the title until the field is edited, the
	/// same default the web new-session modal applies.
	private var effectiveBranch: String {
		let name = branchDirty ? branchName : effectiveTitle
		return name.trimmingCharacters(in: .whitespacesAndNewlines)
	}

	/// A prompt-only session has no issue id to be named after, so the first
	/// few words of the prompt name it (and its branch) unless you say otherwise.
	private var effectiveTitle: String {
		let typed = title.trimmingCharacters(in: .whitespacesAndNewlines)
		if !typed.isEmpty { return typed }
		return StartConfirmSheet.titleFromPrompt(firstPrompt)
	}

	static func titleFromPrompt(_ prompt: String) -> String {
		let words = prompt
			.components(separatedBy: CharacterSet.alphanumerics.inverted)
			.filter { !$0.isEmpty }
			.prefix(6)
		return words.joined(separator: " ")
	}

	var body: some View {
		NavigationStack {
			Form {
				Section("Target") {
					LabeledContent("Project", value: project.name)
					switch kind {
					case .prompt:
						EmptyView()
					case .issue(let issue):
						LabeledContent("Issue", value: issue.title ?? issue.shortId)
					case .pr(let pr):
						LabeledContent("PR", value: pr.title ?? "#\(pr.number)")
					}
				}

				if case .issue(let primary) = kind {
					let others = (store.issuesByProject[project.path] ?? []).filter { $0.id != primary.id }
					if !others.isEmpty {
						Section("Additional issues") {
							DisclosureGroup("\(additionalIssueIds.count) selected") {
								ForEach(others) { issue in
									Toggle(isOn: Binding(
										get: { additionalIssueIds.contains(issue.id) },
										set: { selected in
											if selected { additionalIssueIds.insert(issue.id) }
											else { additionalIssueIds.remove(issue.id) }
										})) { IssueRow(issue: issue) }
										.disabled(additionalIssueIds.count >= 9 && !additionalIssueIds.contains(issue.id))
								}
							}
						}
					}
				}

				Section {
					TextField("Prompt", text: $firstPrompt, axis: .vertical)
						.lineLimit(3...8)
						.accessibilityIdentifier("firstPrompt")
					ScrollView(.horizontal, showsIndicators: false) {
						HStack(spacing: 6) {
							ForEach(tokens, id: \.self) { token in
								Button(token) { insert(token) }
									.font(.caption.monospaced())
									.buttonStyle(.bordered)
									.controlSize(.mini)
							}
						}
					}
				} header: {
					Text("First prompt")
				} footer: {
					Text("Tap a token to insert it; deck fills it in when the session starts.")
				}

				Section("Agent") {
					Picker("Kind", selection: $agentKind) {
						ForEach(availableKinds, id: \.self) { Text($0).tag($0) }
					}
					if agentKind == "pi" {
						TextField("provider (e.g. anthropic)", text: $provider)
							.textInputAutocapitalization(.never)
							.autocorrectionDisabled()
					}
					if !knownModels.isEmpty {
						Picker("Model", selection: $model) {
							Text("Default").tag("")
							ForEach(knownModels, id: \.self) { Text($0).tag($0) }
						}
					}
					TextField("Custom model id (optional)", text: $customModel)
						.textInputAutocapitalization(.never)
						.autocorrectionDisabled()
					if agentKind == "claude" {
						Toggle("Bypass permission prompts (YOLO)", isOn: $yolo)
						Picker("Thinking", selection: $effort) {
							Text("Default").tag("")
							ForEach(DeckEffort.levels, id: \.self) { level in
								Text(level.capitalized).tag(level)
							}
						}
					}
				}

				if !isReview {
					Section {
						TextField("Title (defaults to the first words of the prompt)", text: Binding(
							get: { title.isEmpty ? effectiveTitle : title },
							set: { title = $0 }))
							.accessibilityIdentifier("sessionTitle")
						Picker("Worktree", selection: $worktreeMode) {
							Text("New branch").tag(StartWorktreeMode.newBranch)
							Text("Existing").tag(StartWorktreeMode.existing)
							Text("None").tag(StartWorktreeMode.none)
						}
						if worktreeMode == .newBranch {
							TextField("Branch name (defaults to title)", text: Binding(
								get: { effectiveBranch },
								set: { branchName = $0; branchDirty = true }))
								.textInputAutocapitalization(.never)
								.autocorrectionDisabled()
							if baseChoices.isEmpty {
								TextField("Base branch (optional)", text: $baseBranch)
									.textInputAutocapitalization(.never)
									.autocorrectionDisabled()
							} else {
								Picker("Base branch", selection: $baseBranch) {
									Text("Default").tag("")
									ForEach(baseChoices, id: \.self) { Text($0).tag($0) }
								}
							}
						}
						if worktreeMode == .existing {
							if worktrees.isEmpty {
								Text("No existing worktrees for this project.")
									.font(.footnote)
									.foregroundStyle(.secondary)
							} else {
								Picker("Worktree", selection: $existingWorktree) {
									ForEach(worktrees) { worktree in
										Text("\(worktree.branch) · \(worktree.name)").tag(worktree.path)
									}
								}
							}
						}
					} header: {
						Text("Options")
					} footer: {
						Text(worktreeFooter)
					}
				}

				Section {
					Text(summary)
						.font(.footnote)
						.foregroundStyle(.secondary)
				}

				if let errorMessage {
					Section {
						Text(errorMessage)
							.foregroundStyle(.red)
							.font(.footnote)
					}
				}
			}
			.navigationTitle(navigationTitle)
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ToolbarItem(placement: .cancellationAction) {
					Button("Cancel") { dismiss() }
				}
				ToolbarItem(placement: .confirmationAction) {
					Button(isSubmitting ? "Starting…" : "Start") {
						Task { await start() }
					}
					.disabled(isSubmitting || (worktreeMode == .existing && existingWorktree.isEmpty))
				}
			}
			.task { await setup() }
			.onChange(of: agentKind) { _, _ in seedModel() }
			.onChange(of: worktreeMode) { _, mode in
				if mode == .existing { Task { await loadWorktrees() } }
			}
		}
	}

	private var navigationTitle: String {
		switch kind {
		case .prompt: return "New session"
		case .issue: return "Start work"
		case .pr: return "Start review"
		}
	}

	private var worktreeFooter: String {
		switch worktreeMode {
		case .newBranch: return "Runs in a fresh git worktree on a new branch."
		case .existing: return "Runs in a worktree that already exists, on its current branch."
		case .none: return "Runs directly in the project directory, with no worktree."
		}
	}

	private func insert(_ token: String) {
		if !firstPrompt.isEmpty && !firstPrompt.hasSuffix(" ") { firstPrompt += " " }
		firstPrompt += token
	}

	private var summary: String {
		let target: String
		switch kind {
		case .prompt: target = project.name
		case .issue(let issue): target = "issue \(issue.shortId)"
		case .pr(let pr): target = "PR #\(pr.number)"
		}
		let modelSuffix = effectiveModel().map { " · \($0)" } ?? ""
		let place: String
		if isReview {
			place = "in a worktree checked out from the PR"
		} else if worktreeMode == .newBranch && !effectiveBranch.isEmpty {
			let off = baseBranch.isEmpty ? "" : " off \(baseBranch)"
			place = "in a new git worktree on \(effectiveBranch)\(off)"
		} else if worktreeMode == .existing, let worktree = worktrees.first(where: { $0.path == existingWorktree }) {
			place = "in the existing worktree on \(worktree.branch)"
		} else {
			place = "in the project directory (no worktree)"
		}
		return "Starts a \(agentKind)\(modelSuffix) session on \(target), \(place)."
	}

	private func setup() async {
		agentKind = availableKinds.contains("claude") ? "claude" : (availableKinds.first ?? "claude")
		if case .issue(let issue) = kind { title = issue.issueId }
		if case .prompt = kind { title = "" }
		// The server resolves what the web modal would preselect for this
		// project; fetch it before seeding any field from it.
		await store.loadStartDefaults(projectPath: project.path)
		let defaults = store.startDefaults(kind: agentKind, projectPath: project.path, review: isReview)
		baseBranch = defaults.base ?? ""
		if firstPrompt.isEmpty { firstPrompt = defaults.firstPrompt ?? "" }
		seedModel()
		if !isReview, store.supports(.git), let client = store.client {
			branches = (try? await client.branches(repo: project.path)) ?? []
		}
	}

	private func loadWorktrees() async {
		guard let client = store.client, store.supports(.git) else { return }
		worktrees = ((try? await client.worktrees(repo: project.path)) ?? []).filter { $0.isMain != true }
		if !worktrees.contains(where: { $0.path == existingWorktree }) {
			existingWorktree = worktrees.first?.path ?? ""
		}
	}

	/// Model, provider, effort and permission mode for the picked kind, from the
	/// server's defaults. Re-seeded when the kind changes (the prior values
	/// belong to another agent), which is also what the web modal does.
	private func seedModel() {
		let defaults = store.startDefaults(kind: agentKind, projectPath: project.path, review: isReview)
		let choice = defaults.model
		provider = choice.provider ?? ""
		effort = defaults.effort ?? ""
		yolo = defaults.permissionMode == nil || defaults.permissionMode == "bypassPermissions"
		if choice.model.isEmpty {
			model = ""
			customModel = ""
		} else if knownModels.contains(choice.model) {
			model = choice.model
			customModel = ""
		} else {
			model = ""
			customModel = choice.model
		}
	}

	private func effectiveModel() -> String? {
		let custom = customModel.trimmingCharacters(in: .whitespacesAndNewlines)
		if !custom.isEmpty { return custom }
		return model.isEmpty ? nil : model
	}

	private var primaryIssue: DeckIssue? {
		if case .issue(let issue) = kind { return issue }
		return nil
	}

	private func start() async {
		isSubmitting = true
		errorMessage = nil
		let prompt = firstPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
		let permission: String? = agentKind == "claude" ? (yolo ? "bypassPermissions" : "acceptEdits") : nil
		let providerValue = (agentKind == "pi" && !provider.isEmpty) ? provider : nil
		let effortValue = (agentKind == "claude" && !effort.isEmpty) ? effort : nil
		do {
			let response: CreateSessionResponse
			switch kind {
			case .prompt, .issue:
				let worktree: WorktreeOptions? = worktreeMode == .newBranch
					? .newBranch(named: effectiveBranch, base: baseBranch.isEmpty ? nil : baseBranch)
					: nil
				// An existing worktree is just a different starting directory; the
				// server runs the session there with no worktree of its own.
				let cwd = worktreeMode == .existing && !existingWorktree.isEmpty ? existingWorktree : nil
				response = try await store.startWork(
					issue: primaryIssue,
					additionalIssues: (store.issuesByProject[project.path] ?? []).filter { additionalIssueIds.contains($0.id) },
					project: project,
					prompt: prompt.isEmpty ? nil : prompt,
					kind: agentKind,
					title: effectiveTitle.isEmpty ? nil : effectiveTitle,
					model: effectiveModel(),
					provider: providerValue,
					effort: effortValue,
					permissionMode: permission,
					worktree: worktree,
					cwd: cwd,
					idempotencyKey: idempotencyKey)
			case .pr(let pr):
				response = try await store.startReview(
					pr: pr, project: project,
					prompt: prompt.isEmpty ? nil : prompt,
					kind: agentKind,
					model: effectiveModel(),
					provider: providerValue,
					effort: effortValue,
					permissionMode: permission,
					idempotencyKey: idempotencyKey)
			}
			onCreated(response.id)
			dismiss()
		} catch {
			errorMessage = error.localizedDescription
		}
		isSubmitting = false
	}
}
