import SwiftUI
import DeckKit
import DeckUI

/// Start a workflow run. The app could watch and steer runs but not begin one,
/// so this is the missing half: pick a project, a workflow, and the issue or PR
/// it starts from.
///
/// Which of those two you pick is decided by the workflow, not by a mode switch:
/// a dev workflow runs an issue, a review workflow reviews a PR, and deck
/// rejects the wrong pairing anyway. Offering only the right one is simpler than
/// explaining the rule.
struct StartRunView: View {
	@Environment(DeckStore.self) private var store
	@Environment(\.dismiss) private var dismiss
	/// Handed the run that was started, so the caller can open it.
	var onStarted: (RunDigest) -> Void

	@State private var project: DeckProject?
	@State private var workflow: WorkflowDef?
	@State private var issue: DeckIssue?
	@State private var pr: DeckPR?
	@State private var base = ""
	@State private var starting = false
	@State private var failure: String?

	private var isReview: Bool { workflow?.isReview == true }
	private var issues: [DeckIssue] { project.map { store.issuesByProject[$0.path] ?? [] } ?? [] }
	private var prs: [DeckPR] { project.map { store.prsByProject[$0.path] ?? [] } ?? [] }

	private var canStart: Bool {
		guard project != nil, workflow != nil, !starting else { return false }
		return isReview ? pr != nil : issue != nil
	}

	var body: some View {
		NavigationStack {
			Form {
				if store.projects.isEmpty {
					ContentUnavailableView(
						"No projects",
						systemImage: "folder",
						description: Text("Register a project in deck first."))
				} else {
					settings
					source
				}
				if let failure {
					Section { Text(failure).foregroundStyle(.red).font(.callout) }
				}
				if !store.workflowProblems.isEmpty {
					Section("Skipped workflows") {
						ForEach(store.workflowProblems, id: \.self) { problem in
							Text(problem).font(.caption).foregroundStyle(.secondary)
						}
					}
				}
			}
			.navigationTitle("Start a run")
			.deckInlineNavigationTitle()
			.toolbar {
				ToolbarItem(placement: .cancellationAction) {
					Button("Cancel") { dismiss() }.disabled(starting)
				}
				ToolbarItem(placement: .confirmationAction) {
					Button("Start") { Task { await start() } }.disabled(!canStart)
				}
			}
			.task { await load() }
			.onChange(of: project) { _, _ in
				// A pick from another project can't apply here.
				issue = nil
				pr = nil
				Task { await refreshSource() }
			}
			.onChange(of: isReview) { _, _ in Task { await refreshSource() } }
		}
	}

	@ViewBuilder
	private var settings: some View {
		Section {
			Picker("Project", selection: $project) {
				ForEach(ProjectGroups.grouped(store.projects)) { entry in
					Section(entry.name) {
						ForEach(entry.projects) { Text($0.name).tag(Optional($0)) }
					}
				}
			}
			Picker("Workflow", selection: $workflow) {
				ForEach(WorkflowPicker.grouped(store.workflows), id: \.category) { entry in
					Section(entry.category) {
						ForEach(entry.workflows) { Text($0.name).tag(Optional($0)) }
					}
				}
			}
			TextField("Base branch (optional)", text: $base)
				.deckPlainInput()
		}
	}

	@ViewBuilder
	private var source: some View {
		Section(isReview ? "Pull request" : "Issue") {
			if isReview {
				if prs.isEmpty {
					Text("No open PRs awaiting your review.").foregroundStyle(.secondary).font(.callout)
				}
				ForEach(prs) { candidate in
					picker(isPicked: pr?.id == candidate.id) { pr = candidate } label: {
						PRRow(pr: candidate)
					}
				}
			} else {
				if issues.isEmpty {
					Text("No issues assigned to you here.").foregroundStyle(.secondary).font(.callout)
				}
				ForEach(issues) { candidate in
					picker(isPicked: issue?.id == candidate.id) { issue = candidate } label: {
						IssueRow(issue: candidate)
					}
				}
			}
		}
	}

	/// One selectable row, ticked when it is the pick. Single-select: a run
	/// takes one issue or one PR.
	private func picker<Label: View>(
		isPicked: Bool,
		select: @escaping () -> Void,
		@ViewBuilder label: () -> Label
	) -> some View {
		Button(action: select) {
			HStack(spacing: 12) {
				Image(systemName: isPicked ? "checkmark.circle.fill" : "circle")
					.foregroundStyle(isPicked ? Color.accentColor : .secondary)
				label()
				Spacer(minLength: 0)
			}
			.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.disabled(starting)
	}

	private func load() async {
		// Both are fetched here rather than relied on from sign-in: the store
		// loads projects once at start, and a form that opens before that lands
		// (or after it failed) would otherwise sit on "No projects" for good.
		await store.refreshProjects()
		await store.refreshWorkflows()
		if project == nil { project = store.projects.first { $0.hidden != true } ?? store.projects.first }
		if workflow == nil { workflow = WorkflowPicker.initial(store.workflows) }
		await refreshSource()
	}

	private func refreshSource() async {
		guard let project else { return }
		if isReview {
			await store.refreshPRs(project: project.path)
		} else {
			await store.refreshIssues(project: project.path, refresh: false)
		}
	}

	private func start() async {
		guard let project, let workflow else { return }
		starting = true
		failure = nil
		do {
			let run = try await store.startRun(
				cwd: project.path, workflow: workflow,
				issue: isReview ? nil : issue, pr: isReview ? pr : nil,
				base: base.trimmingCharacters(in: .whitespaces))
			onStarted(run)
			dismiss()
		} catch {
			failure = error.localizedDescription
			starting = false
		}
	}
}
