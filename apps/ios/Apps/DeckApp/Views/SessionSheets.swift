import SwiftUI
import DeckKit
import DeckUI

struct ModelPickerSheet: View {
	let kind: String
	let current: String?
	let available: [String]
	var onSelect: (String?) -> Void

	@Environment(\.dismiss) private var dismiss
	@State private var customModel = ""
	@State private var picked: String?

	var body: some View {
		#if os(macOS)
		macBody
		#else
		phoneBody
		#endif
	}

	#if os(macOS)
	/// A model set by hand stays on the list, so the dialog can show it as the pick.
	private var macModels: [String] {
		if let current, !available.contains(current) { return available + [current] }
		return available
	}

	private var macBody: some View {
		let custom = customModel.trimmingCharacters(in: .whitespacesAndNewlines)
		return MacDialog(title: "Model", message: "Applies on the next turn. Stop a running turn first.") {
			MacDialogList {
				Picker("Model", selection: $picked) {
					Text("Default (\(kind))").tag(String?.none)
					ForEach(macModels, id: \.self) { Text($0).tag(String?.some($0)) }
				}
				.pickerStyle(.radioGroup)
				.labelsHidden()
				.disabled(!custom.isEmpty)
			}
			TextField("Custom model id", text: $customModel, prompt: Text("Custom model id"))
				.labelsHidden()
				.deckPlainInput()
		} actions: {
			MacCancelButton()
			Button("Save") {
				let choice = custom.isEmpty ? picked : custom
				// deck refuses any change during a turn, even to the same model.
				if choice != current { onSelect(choice) }
				dismiss()
			}
			.keyboardShortcut(.defaultAction)
		}
		.onAppear { picked = current }
	}
	#endif

	private var phoneBody: some View {
		NavigationStack {
			List {
				Section {
					row(label: "Default (\(kind))", value: nil)
				}
				if !available.isEmpty {
					Section("Models") {
						ForEach(available, id: \.self) { model in
							row(label: model, value: model)
						}
					}
				}
				Section("Custom") {
					HStack {
						TextField("model id", text: $customModel)
							.deckPlainInput()
						Button("Set") {
							onSelect(customModel.trimmingCharacters(in: .whitespacesAndNewlines))
							dismiss()
						}
						.disabled(customModel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
					}
				}
			}
			.navigationTitle("Model")
			.deckInlineNavigationTitle()
			.toolbar {
				ToolbarItem(placement: .cancellationAction) {
					Button("Cancel") { dismiss() }
				}
			}
			.safeAreaInset(edge: .bottom) {
				Text("Applies on the next turn. Stop a running turn first.")
					.font(.footnote)
					.foregroundStyle(.secondary)
					.padding()
					.frame(maxWidth: .infinity)
					.deckGlass(in: Rectangle())
			}
		}
	}

	private func row(label: String, value: String?) -> some View {
		Button {
			onSelect(value)
			dismiss()
		} label: {
			HStack {
				Text(label)
				Spacer()
				if value == current || (value == nil && current == nil) {
					Image(systemName: "checkmark").foregroundStyle(.tint)
				}
			}
		}
		.foregroundStyle(.primary)
	}
}

/// Renaming a session. A sheet rather than an alert with a text field, so a
/// refusal from deck (a name another terminal already holds, say) has somewhere
/// to show without stacking a second alert on the first.
struct RenameSessionSheet: View {
	let current: String
	/// Saves the name and returns what went wrong, or nil once it went through.
	var onSave: (String) async -> String?

	@Environment(\.dismiss) private var dismiss
	@State private var draft = ""
	@State private var saving = false
	@State private var failure: String?
	@FocusState private var focused: Bool

	private var trimmed: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }

	var body: some View {
		#if os(macOS)
		macBody
		#else
		phoneBody
		#endif
	}

	#if os(macOS)
	private var macBody: some View {
		MacDialog(title: "Rename session") {
			TextField("Session name", text: $draft, prompt: Text("Session name"))
				.labelsHidden()
				.focused($focused)
				.onSubmit { save() }
				.disabled(saving)
				.accessibilityIdentifier("renameField")
			if let failure {
				Text(failure)
					.foregroundStyle(.red)
					.fixedSize(horizontal: false, vertical: true)
			}
		} actions: {
			MacCancelButton().disabled(saving)
			Button("Save") { save() }
				.keyboardShortcut(.defaultAction)
				.disabled(saving || trimmed.isEmpty)
				.accessibilityIdentifier("renameSave")
		}
		.onAppear {
			// Cut before focusing, so the whole name is what comes up selected.
			draft = String(current.prefix(SessionTitle.maxLength))
			focused = true
		}
		.onChange(of: draft) { _, text in clamp(text) }
		// Disabling the field while saving took the focus away from it.
		.onChange(of: failure) { if failure != nil { focused = true } }
	}
	#endif

	private var phoneBody: some View {
		NavigationStack {
			Form {
				Section {
					TextField("Session name", text: $draft)
						.focused($focused)
						.submitLabel(.done)
						.onSubmit { save() }
						.disabled(saving)
						.accessibilityIdentifier("renameField")
				} footer: {
					if let failure {
						Text(failure).foregroundStyle(.red)
					}
				}
			}
			.navigationTitle("Rename session")
			.deckInlineNavigationTitle()
			.toolbar {
				ToolbarItem(placement: .cancellationAction) {
					Button("Cancel") { dismiss() }.disabled(saving)
				}
				ToolbarItem(placement: .confirmationAction) {
					Button("Save") { save() }
						.disabled(saving || trimmed.isEmpty)
						.accessibilityIdentifier("renameSave")
				}
			}
			.onAppear {
				draft = current
				focused = true
			}
			.onChange(of: draft) { _, text in clamp(text) }
		}
		.presentationDetents([.height(220)])
	}

	/// deck refuses a longer title, so stop it here rather than at the round trip.
	private func clamp(_ text: String) {
		if text.count > SessionTitle.maxLength {
			draft = String(text.prefix(SessionTitle.maxLength))
		}
	}

	private func save() {
		guard !trimmed.isEmpty, !saving else { return }
		saving = true
		failure = nil
		Task {
			let problem = await onSave(trimmed)
			saving = false
			if let problem { failure = problem } else { dismiss() }
		}
	}
}

struct MergeSheet: View {
	let pr: SessionPR?
	var onMerge: (_ method: String, _ deleteBranch: Bool) -> Void

	@Environment(\.dismiss) private var dismiss
	@State private var method = "squash"
	@State private var deleteBranch = true

	var body: some View {
		#if os(macOS)
		MacDialog(title: mergeTitle) {
			methodPicker
			Toggle("Delete branch after merge", isOn: $deleteBranch)
				.toggleStyle(.checkbox)
		} actions: {
			MacCancelButton()
			Button("Merge") {
				onMerge(method, deleteBranch)
				dismiss()
			}
			.keyboardShortcut(.defaultAction)
		}
		#else
		phoneBody
		#endif
	}

	private var methodPicker: some View {
		Picker("Method", selection: $method) {
			Text("Squash").tag("squash")
			Text("Merge").tag("merge")
			Text("Rebase").tag("rebase")
		}
		.pickerStyle(.segmented)
	}

	private var phoneBody: some View {
		NavigationStack {
			Form {
				methodPicker

				Toggle("Delete branch after merge", isOn: $deleteBranch)

				Button {
					onMerge(method, deleteBranch)
					dismiss()
				} label: {
					Label("Merge pull request", systemImage: "arrow.triangle.merge")
						.frame(maxWidth: .infinity)
				}
				.buttonStyle(.borderedProminent)
			}
			.navigationTitle(mergeTitle)
			.deckInlineNavigationTitle()
			.toolbar {
				ToolbarItem(placement: .cancellationAction) {
					Button("Cancel") { dismiss() }
				}
			}
		}
		.presentationDetents([.medium])
	}

	private var mergeTitle: String {
		if let repo = pr?.repo, let number = pr?.number { return "Merge \(repo)#\(number)" }
		return "Merge"
	}
}

struct DeleteSessionSheet: View {
	let hasWorktree: Bool
	var count: Int = 1
	var name: String? = nil
	/// The sessions being deleted, so a running one gets the in-progress warning.
	let sessions: [SessionDigest]
	var onDelete: (_ deleteWorktree: Bool, _ deleteBranch: Bool) -> Void

	@Environment(\.dismiss) private var dismiss
	@State private var deleteWorktree = true
	@State private var deleteBranch = true

	var body: some View {
		#if os(macOS)
		macBody
		#else
		phoneBody
		#endif
	}

	#if os(macOS)
	/// A Mac confirmation: title, one line, checkboxes, Cancel / Delete at the bottom right.
	private var macBody: some View {
		MacDialog(title: macTitle) {
			if let warning = DeleteWarning.message(sessions) {
				Label(warning, systemImage: "exclamationmark.triangle.fill")
					.foregroundStyle(.orange)
					.fixedSize(horizontal: false, vertical: true)
					.padding(.bottom, 4)
			}
			Text(count == 1
				? "The session stops and leaves deck. This can't be undone."
				: "The sessions stop and leave deck. This can't be undone.")
				.foregroundStyle(.secondary)
				.fixedSize(horizontal: false, vertical: true)
			if hasWorktree {
				Toggle(worktreeLabel, isOn: $deleteWorktree)
					.toggleStyle(.checkbox)
				Toggle(branchLabel, isOn: $deleteBranch)
					.toggleStyle(.checkbox)
					.disabled(!deleteWorktree)
			}
		} actions: {
			MacCancelButton()
			// No default button: Return must not delete a worktree by habit.
			Button(DeleteWarning.buttonLabel(sessions, plain: "Delete"), role: .destructive, action: confirm)
		}
		.onChange(of: deleteWorktree) { _, on in
			if !on { deleteBranch = false }
		}
	}

	private var macTitle: String {
		if count == 1, let name, !name.isEmpty { return "Delete \u{201C}\(name)\u{201D}?" }
		return count == 1 ? "Delete this session?" : "Delete \(count) sessions?"
	}
	#endif

	private func confirm() {
		onDelete(hasWorktree && deleteWorktree, hasWorktree && deleteWorktree && deleteBranch)
		dismiss()
	}

	private var phoneBody: some View {
		NavigationStack {
			Form {
				if let warning = DeleteWarning.message(sessions) {
					Section {
						Label(warning, systemImage: "exclamationmark.triangle.fill")
							.foregroundStyle(.orange)
					}
				}
				if hasWorktree {
					Section {
						Toggle(worktreeLabel, isOn: $deleteWorktree)
						Toggle(branchLabel, isOn: $deleteBranch)
							.disabled(!deleteWorktree)
					} footer: {
						Text(count == 1
							? "Turn these off to keep the worktree and branch on disk."
							: "Applies to every selected session that has a worktree. Turn these off to keep them on disk.")
					}
				}
				Section {
					Button(role: .destructive, action: confirm) {
						Text(DeleteWarning.buttonLabel(sessions, plain: title)).frame(maxWidth: .infinity)
					}
				}
			}
			.navigationTitle(title)
			.deckInlineNavigationTitle()
			.toolbar {
				ToolbarItem(placement: .cancellationAction) {
					Button("Cancel") { dismiss() }
				}
			}
		}
		.presentationDetents([.medium])
		.onChange(of: deleteWorktree) { _, on in
			if !on { deleteBranch = false }
		}
	}

	private var title: String {
		count == 1 ? "Delete session" : "Delete \(count) sessions"
	}

	private var worktreeLabel: String {
		count == 1 ? "Delete git worktree" : "Delete git worktrees"
	}

	private var branchLabel: String {
		count == 1 ? "Delete branch" : "Delete branches"
	}
}

struct EffortPickerSheet: View {
	let current: String?
	var onSelect: (String?) -> Void

	@Environment(\.dismiss) private var dismiss
	@State private var picked: String?

	var body: some View {
		#if os(macOS)
		MacDialog(title: "Thinking level", message: "Claude reasoning effort. Applies on the next turn.") {
			Picker("Thinking level", selection: $picked) {
				Text("Default").tag(String?.none)
				ForEach(DeckEffort.levels, id: \.self) { Text($0.capitalized).tag(String?.some($0)) }
			}
			.pickerStyle(.radioGroup)
			.labelsHidden()
		} actions: {
			MacCancelButton()
			Button("Save") {
				// deck refuses any change during a turn, even to the same level.
				if picked != current { onSelect(picked) }
				dismiss()
			}
			.keyboardShortcut(.defaultAction)
		}
		.onAppear { picked = current }
		#else
		phoneBody
		#endif
	}

	private var phoneBody: some View {
		NavigationStack {
			List {
				row(label: "Default", value: nil)
				ForEach(DeckEffort.levels, id: \.self) { level in
					row(label: level.capitalized, value: level)
				}
			}
			.navigationTitle("Thinking level")
			.deckInlineNavigationTitle()
			.toolbar {
				ToolbarItem(placement: .cancellationAction) {
					Button("Cancel") { dismiss() }
				}
			}
			.safeAreaInset(edge: .bottom) {
				Text("Claude reasoning effort. Applies on the next turn.")
					.font(.footnote)
					.foregroundStyle(.secondary)
					.padding()
					.frame(maxWidth: .infinity)
					.deckGlass(in: Rectangle())
			}
		}
	}

	private func row(label: String, value: String?) -> some View {
		Button {
			onSelect(value)
			dismiss()
		} label: {
			HStack {
				Text(label)
				Spacer()
				if value == current || (value == nil && current == nil) {
					Image(systemName: "checkmark").foregroundStyle(.tint)
				}
			}
		}
		.foregroundStyle(.primary)
	}
}
