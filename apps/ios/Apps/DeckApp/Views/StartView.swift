import SwiftUI
import DeckKit
import DeckUI

struct StartView: View {
	enum Mode: String, CaseIterable, Identifiable {
		case prompt = "Prompt"
		case issues = "Issues"
		case prs = "PRs"
		var id: String { rawValue }
	}

	/// The session on screen when Start opened; its project is the default.
	var openSessionId: String?
	/// Bumped each time Start is opened, which re-applies that default.
	var opening = 0
	var onSessionCreated: (String) -> Void

	@Environment(DeckStore.self) private var store
	@State private var selectedProject: DeckProject?
	/// "Custom path…" is picked: start in the typed folder instead of a project.
	@State private var custom = false
	@State private var customPath = ""
	@State private var mode: Mode = .issues
	@State private var selectedIssue: DeckIssue?
	@State private var selectedPR: DeckPR?
	@State private var startingPrompt = false
	@State private var startingShell = false
	@State private var shellError: String?

	var body: some View {
		NavigationStack {
			VStack(spacing: 0) {
				if store.projects.isEmpty {
					ContentUnavailableView(
						"No projects",
						systemImage: "folder",
						description: Text("Register a project in deck first."))
				} else {
					// nil stands for the custom path, so the picked project survives a
					// look at it and comes back when picked again.
					Picker("Project", selection: Binding(
						get: { custom ? nil : selectedProject },
						set: { picked in
							custom = picked == nil
							if let picked { selectedProject = picked }
						})) {
						ForEach(ProjectGroups.grouped(store.projects)) { entry in
							Section(entry.name) {
								ForEach(entry.projects) { project in
									Text(project.name).tag(Optional(project))
								}
							}
						}
						Text("Custom path…").tag(DeckProject?.none)
					}
					.pickerStyle(.menu)
					.padding(.horizontal)
					.accessibilityIdentifier("startProject")

					// A folder has no issues or PRs, so it only starts from a prompt.
					if !custom {
						Picker("Mode", selection: $mode) {
							ForEach(Mode.allCases) { mode in
								Text(mode.rawValue).tag(mode)
							}
						}
						.pickerStyle(.segmented)
						.padding()
					}

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
			// Once per opening rather than per appearance, so a project picked by
			// hand survives a trip to Schedules.
			.onChange(of: opening) { _, _ in pickDefaultProject() }
			// Projects that land after the first look still get a default, or the
			// menu would show the custom path as picked.
			.onChange(of: store.projects) { _, _ in
				if selectedProject == nil && !custom { pickDefaultProject() }
			}
			.onChange(of: selectedProject) { _, _ in Task { await refresh() } }
			.onChange(of: mode) { _, _ in Task { await refresh() } }
			.sheet(item: $selectedIssue) { issue in
				if let project = activeProject {
					StartConfirmSheet(kind: .issue(issue), project: project, onCreated: onSessionCreated)
				}
			}
			.sheet(item: $selectedPR) { pr in
				if let project = activeProject {
					StartConfirmSheet(kind: .pr(pr), project: project, onCreated: onSessionCreated)
				}
			}
			.alert("Couldn't start a terminal", isPresented: Binding(get: { shellError != nil }, set: { if !$0 { shellError = nil } })) {
				Button("OK", role: .cancel) {}
			} message: {
				Text(shellError ?? "")
			}
			.sheet(isPresented: $startingPrompt) {
				if let project = activeProject {
					StartConfirmSheet(kind: .prompt, project: project, onCreated: onSessionCreated)
				}
			}
		}
	}

	/// The picked project, or the typed folder standing in for one.
	private var activeProject: DeckProject? {
		guard custom else { return selectedProject }
		let path = customPath.trimmingCharacters(in: .whitespacesAndNewlines)
		return path.isEmpty ? nil : DeckProject(folder: path)
	}

	@ViewBuilder
	private var list: some View {
		if custom || selectedProject != nil {
			List {
				if custom {
					// In the list so its suggestions scroll rather than push the rows away.
					PathField(path: $customPath)
						.accessibilityIdentifier("customPath")
				}
				if let project = activeProject {
					switch custom ? .prompt : mode {
					case .prompt:
						// Work with no issue or PR behind it: just a project and a
						// first message.
						Button {
							startingPrompt = true
						} label: {
							Label("New session in \(project.name)", systemImage: "plus.circle")
						}
						Text(custom
							? "Starts a session in this folder with whatever you type as the first message."
							: "Starts a session on its own branch with whatever you type as the first message.")
							.font(.footnote)
							.foregroundStyle(.secondary)
						if store.supports(.terminal) {
							Button {
								Task { await startShell(in: project) }
							} label: {
								Label("Terminal in \(project.name)", systemImage: "terminal")
							}
							.disabled(startingShell)
							.accessibilityIdentifier("startShell")
						}
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
			}
			.listStyle(.plain)
			.refreshable { await refresh(force: true) }
		}
	}

	private func startShell(in project: DeckProject) async {
		startingShell = true
		defer { startingShell = false }
		do {
			onSessionCreated(try await store.startShell(project: project).id)
		} catch {
			shellError = error.localizedDescription
		}
	}

	private func ensureDefaultProject() async {
		if selectedProject == nil { pickDefaultProject() }
		await refresh()
	}

	private func pickDefaultProject() {
		custom = false
		let open = store.sessions.first { $0.id == openSessionId }
		selectedProject = SessionProject.startDefault(openSession: open, current: selectedProject, in: store.projects)
	}

	private func refresh(force: Bool = false) async {
		guard !custom, let project = selectedProject else { return }
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
				Text(verbatim: "#\(pr.number)")
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
	@State private var additionalPRIds: Set<String> = []
	@State private var splitPerIssue = false
	/// Kept across retries so each item keeps its idempotency key and a retry
	/// only re-sends the creates that did not land.
	@State private var plan: StartPlan?
	@State private var showConflict = false
	@State private var errorMessage: String?
	@State private var confirmingExpensive = false
	/// Start waits for the defaults, which carry the expensive-model list.
	@State private var defaultsLoaded = false

	private var isReview: Bool { if case .pr = kind { return true }; return false }

	/// A typed folder rather than a project: the server only makes worktrees
	/// inside registered projects, so it runs in the folder itself.
	private var isFolder: Bool { !store.projects.contains { $0.path == project.path } }

	/// One session per issue needs a fresh worktree for each, as on the web.
	private var canSplit: Bool { !additionalIssueIds.isEmpty && worktreeMode == .newBranch }
	private var isSplitting: Bool { splitPerIssue && canSplit }

	private var sessionCount: Int {
		if isReview { return 1 + additionalPRIds.count }
		return isSplitting ? 1 + additionalIssueIds.count : 1
	}

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
				// First, so a phone shows it without scrolling past the whole form.
				if let errorMessage {
					Section {
						Text(errorMessage)
							.foregroundStyle(.red)
							.font(.footnote)
					}
				}
				Section("Target") {
					if isFolder {
						LabeledContent("Folder", value: project.path)
					} else {
						LabeledContent("Project", value: project.name)
					}
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
									Toggle(isOn: member(issue.id, of: $additionalIssueIds)) { IssueRow(issue: issue) }
										.disabled(additionalIssueIds.count >= 9 && !additionalIssueIds.contains(issue.id))
								}
							}
							if canSplit {
								Toggle("One session per issue", isOn: $splitPerIssue)
									.accessibilityIdentifier("splitPerIssue")
							}
						}
					}
				}

				if case .pr(let primary) = kind {
					let others = (store.prsByProject[project.path] ?? []).filter { $0.id != primary.id }
					if !others.isEmpty {
						Section {
							DisclosureGroup("\(additionalPRIds.count) selected") {
								ForEach(others) { pr in
									Toggle(isOn: member(pr.id, of: $additionalPRIds)) { PRRow(pr: pr) }
										.disabled(additionalPRIds.count >= 9 && !additionalPRIds.contains(pr.id))
								}
							}
						} header: {
							Text("More PRs")
						} footer: {
							Text("Each PR gets its own review session.")
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
							.deckPlainInput()
					}
					if !knownModels.isEmpty {
						Picker("Model", selection: $model) {
							Text("Default").tag("")
							ForEach(knownModels, id: \.self) { Text($0).tag($0) }
						}
					}
					TextField("Custom model id (optional)", text: $customModel)
						.deckPlainInput()
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
						if !isSplitting {
							TextField("Title (defaults to the first words of the prompt)", text: Binding(
								get: { title.isEmpty ? effectiveTitle : title },
								set: { title = $0 }))
								.accessibilityIdentifier("sessionTitle")
						}
						if !isFolder {
							Picker("Worktree", selection: $worktreeMode) {
								Text("New branch").tag(StartWorktreeMode.newBranch)
								Text("Existing").tag(StartWorktreeMode.existing)
								Text("None").tag(StartWorktreeMode.none)
							}
						}
						if worktreeMode == .newBranch && !isSplitting {
							TextField("Branch name (defaults to title)", text: Binding(
								get: { effectiveBranch },
								set: { branchName = $0; branchDirty = true }))
								.deckPlainInput()
						}
						if worktreeMode == .newBranch {
							if baseChoices.isEmpty {
								TextField("Base branch (optional)", text: $baseBranch)
									.deckPlainInput()
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

				if let plan, plan.items.count > 1 {
					Section("Sessions") {
						ForEach(plan.items) { item in
							HStack {
								Text(item.label).font(.body.monospaced())
								Spacer()
								StartItemStatus(status: item.status)
							}
						}
					}
				}

			}
			.navigationTitle(navigationTitle)
			.deckInlineNavigationTitle()
			.toolbar {
				ToolbarItem(placement: .cancellationAction) {
					Button("Cancel") { dismiss() }
				}
				ToolbarItem(placement: .confirmationAction) {
					Button(isSubmitting ? "Starting…" : (hasFailures ? "Retry" : "Start")) {
						if pickIsExpensive && !hasFailures {
							confirmingExpensive = true
						} else {
							Task { await start() }
						}
					}
					.disabled(!defaultsLoaded || isSubmitting || (worktreeMode == .existing && existingWorktree.isEmpty))
				}
			}
			.alert("Expensive model", isPresented: $confirmingExpensive) {
				Button("Cancel", role: .cancel) {}
				Button("Start anyway") { Task { await start() } }
			} message: {
				Text("\(effectiveModel() ?? "") is an expensive model. Start this session on it anyway?")
			}
			.task { await setup() }
			.alert(conflictTitle, isPresented: $showConflict) {
				ForEach(WorktreeFix.allCases, id: \.self) { fix in
					Button(fix.label, role: fix == .recreate ? .destructive : nil) { resolveConflicts(fix) }
				}
				Button("Cancel", role: .cancel) {}
			} message: {
				Text(conflictText)
			}
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

	private var hasFailures: Bool {
		guard let plan else { return false }
		return !plan.failures.isEmpty || !plan.conflicts.isEmpty
	}

	private var conflictTitle: String {
		(plan?.conflicts.count ?? 0) > 1 ? "Branches already exist" : "Branch already exists"
	}

	private var conflictText: String {
		let conflicts = plan?.conflicts ?? []
		let found = conflicts.map(\.message).joined(separator: "\n")
		guard conflicts.count == 1, let branch = conflicts.first?.branch else {
			return found + "\n\nYour choice applies to each of them."
		}
		let fixes = WorktreeFix.allCases.map { "\($0.label): \($0.detail(branch: branch))" }
		return ([found] + fixes).joined(separator: "\n\n")
	}

	private func member(_ id: String, of set: Binding<Set<String>>) -> Binding<Bool> {
		Binding(
			get: { set.wrappedValue.contains(id) },
			set: { selected in
				if selected { set.wrappedValue.insert(id) } else { set.wrappedValue.remove(id) }
			})
	}

	private var worktreeFooter: String {
		if isSplitting {
			return "Each issue gets its own session and worktree, on a new branch named after the issue."
		}
		switch worktreeMode {
		case .newBranch: return "Runs in a fresh git worktree on a new branch."
		case .existing: return "Runs in a worktree that already exists, on its current branch."
		case .none: return isFolder ? "Runs directly in this folder." : "Runs directly in the project directory, with no worktree."
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
		if sessionCount > 1 {
			let per = isReview ? "PR" : "issue"
			return "Starts \(sessionCount) \(agentKind)\(modelSuffix) sessions, one per \(per), each in its own worktree."
		}
		let place: String
		if isReview {
			place = "in a worktree checked out from the PR"
		} else if worktreeMode == .newBranch && !effectiveBranch.isEmpty {
			let off = baseBranch.isEmpty ? "" : " off \(baseBranch)"
			place = "in a new git worktree on \(effectiveBranch)\(off)"
		} else if worktreeMode == .existing, let worktree = worktrees.first(where: { $0.path == existingWorktree }) {
			place = "in the existing worktree on \(worktree.branch)"
		} else if isFolder {
			place = "in \(project.path)"
		} else {
			place = "in the project directory (no worktree)"
		}
		return "Starts a \(agentKind)\(modelSuffix) session on \(target), \(place)."
	}

	private func setup() async {
		agentKind = availableKinds.contains("claude") ? "claude" : (availableKinds.first ?? "claude")
		if case .issue(let issue) = kind { title = issue.issueId }
		if case .prompt = kind { title = "" }
		if isFolder { worktreeMode = .none }
		// The server resolves what the web modal would preselect for this
		// project; fetch it before seeding any field from it.
		await store.loadStartDefaults(projectPath: project.path)
		let defaults = store.startDefaults(kind: agentKind, projectPath: project.path, review: isReview)
		baseBranch = defaults.base ?? ""
		if firstPrompt.isEmpty { firstPrompt = defaults.firstPrompt ?? "" }
		seedModel()
		defaultsLoaded = true
		if !isReview, !isFolder, store.supports(.git), let client = store.client {
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

	/// The server's list arrives with the defaults `setup` fetches.
	private var pickIsExpensive: Bool {
		store.needsExpensiveConfirm(
			model: effectiveModel(), provider: agentKind == "pi" ? provider : nil, kind: agentKind)
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
		errorMessage = nil
		let fresh = buildPlan()
		plan = plan.map { $0.carrying(into: fresh) } ?? fresh
		await run()
	}

	private func buildPlan() -> StartPlan {
		var base = CreateSessionRequest(mode: isReview ? .review : .work, cwd: project.path)
		let prompt = firstPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
		base.prompt = prompt.isEmpty ? nil : prompt
		base.kind = agentKind
		base.model = effectiveModel()
		base.provider = (agentKind == "pi" && !provider.isEmpty) ? provider : nil
		base.effort = (agentKind == "claude" && !effort.isEmpty) ? effort : nil
		base.permissionMode = agentKind == "claude" ? (yolo ? "bypassPermissions" : "acceptEdits") : nil
		switch kind {
		case .pr(let pr):
			let more = (store.prsByProject[project.path] ?? []).filter { additionalPRIds.contains($0.id) && $0.id != pr.id }
			return .review(base, prs: [pr] + more)
		case .prompt, .issue:
			let baseRef = baseBranch.isEmpty ? nil : baseBranch
			base.title = effectiveTitle.isEmpty ? nil : effectiveTitle
			// Split names each branch after its issue, so it needs no name here.
			base.worktree = isSplitting
				? WorktreeOptions(newBranch: true, base: baseRef)
				: (worktreeMode == .newBranch ? .newBranch(named: effectiveBranch, base: baseRef) : nil)
			// An existing worktree is just a different starting directory; the
			// server runs the session there with no worktree of its own.
			if worktreeMode == .existing && !existingWorktree.isEmpty { base.cwd = existingWorktree }
			let more = (store.issuesByProject[project.path] ?? []).filter { additionalIssueIds.contains($0.id) }
			return .work(base, issues: primaryIssue.map { [$0] + more } ?? [], split: isSplitting)
		}
	}

	/// Send every create not yet made, concurrently so one slow worktree does
	/// not hold up the rest, then finish, ask about a conflict, or say what failed.
	private func run() async {
		guard var current = plan else { return }
		isSubmitting = true
		let batch = current.begin()
		plan = current
		let store = store
		await withTaskGroup(of: (String, StartPlan.Status).self) { group in
			for item in batch {
				group.addTask {
					do {
						let id = try await store.createSession(item.request, idempotencyKey: item.idempotencyKey)
						return (item.id, .created(id: id))
					} catch {
						return (item.id, StartPlan.status(for: error))
					}
				}
			}
			for await (id, status) in group { plan?.record(id, status) }
		}
		await store.refreshSessions()
		isSubmitting = false
		report()
	}

	private func report() {
		guard let plan else { return }
		if plan.isFinished, let first = plan.createdIds.first {
			onCreated(first)
			dismiss()
			return
		}
		if !plan.conflicts.isEmpty { showConflict = true }
		if plan.items.count == 1, let failure = plan.failures.first {
			errorMessage = failure.message
		} else if !plan.failures.isEmpty {
			errorMessage = "Started \(plan.createdIds.count) of \(plan.items.count). Retry starts only the ones that failed."
		}
	}

	private func resolveConflicts(_ fix: WorktreeFix) {
		plan?.resolveConflicts(with: fix)
		Task { await run() }
	}
}

/// Where one create of a multi-session start has got to.
private struct StartItemStatus: View {
	let status: StartPlan.Status

	var body: some View {
		switch status {
		case .pending:
			Text("Waiting").foregroundStyle(.secondary)
		case .running:
			ProgressView()
		case .created:
			Image(systemName: "checkmark.circle.fill")
				.foregroundStyle(.green)
				.accessibilityLabel("Started")
		case .failed(let message):
			Text(message)
				.font(.caption)
				.foregroundStyle(.red)
				.lineLimit(2)
		case .conflict:
			Text("Branch exists")
				.font(.caption)
				.foregroundStyle(.orange)
		}
	}
}
