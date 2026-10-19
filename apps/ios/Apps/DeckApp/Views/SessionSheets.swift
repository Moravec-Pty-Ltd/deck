import SwiftUI
import DeckKit

struct ModelPickerSheet: View {
	let kind: String
	let current: String?
	let available: [String]
	var onSelect: (String?) -> Void

	@Environment(\.dismiss) private var dismiss
	@State private var customModel = ""

	var body: some View {
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
							.textInputAutocapitalization(.never)
							.autocorrectionDisabled()
						Button("Set") {
							onSelect(customModel.trimmingCharacters(in: .whitespacesAndNewlines))
							dismiss()
						}
						.disabled(customModel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
					}
				}
			}
			.navigationTitle("Model")
			.navigationBarTitleDisplayMode(.inline)
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
					.background(.thinMaterial)
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
			.navigationBarTitleDisplayMode(.inline)
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
			// deck refuses a longer title, so stop it here rather than at the
			// round trip.
			.onChange(of: draft) { _, text in
				if text.count > SessionTitle.maxLength {
					draft = String(text.prefix(SessionTitle.maxLength))
				}
			}
		}
		.presentationDetents([.height(220)])
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
		NavigationStack {
			Form {
				Picker("Method", selection: $method) {
					Text("Squash").tag("squash")
					Text("Merge").tag("merge")
					Text("Rebase").tag("rebase")
				}
				.pickerStyle(.segmented)

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
			.navigationBarTitleDisplayMode(.inline)
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
	var onDelete: (_ deleteWorktree: Bool, _ deleteBranch: Bool) -> Void

	@Environment(\.dismiss) private var dismiss
	@State private var deleteWorktree = true
	@State private var deleteBranch = true

	var body: some View {
		NavigationStack {
			Form {
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
					Button(role: .destructive) {
						onDelete(hasWorktree && deleteWorktree, hasWorktree && deleteWorktree && deleteBranch)
						dismiss()
					} label: {
						Text(title).frame(maxWidth: .infinity)
					}
				}
			}
			.navigationTitle(title)
			.navigationBarTitleDisplayMode(.inline)
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

struct QuickMessagesSheet: View {
	@Environment(DeckStore.self) private var store
	@Environment(\.dismiss) private var dismiss

	@State private var drafts: [QuickMessage] = []
	@State private var isSaving = false
	@State private var errorMessage: String?

	var body: some View {
		NavigationStack {
			Form {
				Section {
					Text("Tap a message in the composer to send it. Text may contain tokens like [issue_url] or [branch-name]; deck fills them in when you send.")
						.font(.footnote)
						.foregroundStyle(.secondary)
				}
				ForEach($drafts) { $message in
					Section {
						TextField("Label (optional)", text: Binding(
							get: { message.label ?? "" },
							set: { message.label = $0.isEmpty ? nil : $0 }))
						TextField("Message text", text: $message.text, axis: .vertical)
							.lineLimit(1...6)
					}
				}
				.onDelete { drafts.remove(atOffsets: $0) }

				Section {
					Button {
						drafts.append(QuickMessage(text: ""))
					} label: {
						Label("Add message", systemImage: "plus")
					}
				}

				if let errorMessage {
					Section {
						Text(errorMessage).foregroundStyle(.red).font(.footnote)
					}
				}
			}
			.navigationTitle("Quick messages")
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ToolbarItem(placement: .cancellationAction) {
					Button("Cancel") { dismiss() }
				}
				ToolbarItem(placement: .confirmationAction) {
					Button(isSaving ? "Saving…" : "Save") {
						Task { await save() }
					}
					.disabled(isSaving)
				}
			}
			.task {
				await store.refreshQuickMessages()
				drafts = store.quickMessages
			}
		}
	}

	private func save() async {
		isSaving = true
		errorMessage = nil
		let cleaned = drafts
			.map { QuickMessage(id: $0.id, label: $0.label, text: $0.text.trimmingCharacters(in: .whitespacesAndNewlines)) }
			.filter { !$0.text.isEmpty }
		do {
			try await store.saveQuickMessages(cleaned)
			dismiss()
		} catch {
			errorMessage = error.localizedDescription
		}
		isSaving = false
	}
}

struct EffortPickerSheet: View {
	let current: String?
	var onSelect: (String?) -> Void

	@Environment(\.dismiss) private var dismiss

	var body: some View {
		NavigationStack {
			List {
				row(label: "Default", value: nil)
				ForEach(DeckEffort.levels, id: \.self) { level in
					row(label: level.capitalized, value: level)
				}
			}
			.navigationTitle("Thinking level")
			.navigationBarTitleDisplayMode(.inline)
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
					.background(.thinMaterial)
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
