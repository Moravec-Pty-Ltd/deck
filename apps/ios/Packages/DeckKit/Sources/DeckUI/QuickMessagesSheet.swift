import SwiftUI
import DeckKit

/// The quick-message editor the phone, iPad and Mac share, mirroring the web's
/// Manage modal: a section per scope (Global, then each project with messages),
/// reordering within a section, and a picker that moves a message to another
/// scope. A server without `quick-messages-by-project` would drop the scope, so
/// there the editor is one flat list as before.
public struct QuickMessagesSheet: View {
	@Environment(DeckStore.self) private var store
	@Environment(\.dismiss) private var dismiss

	@State private var drafts: [QuickMessage] = []
	@State private var isSaving = false
	@State private var errorMessage: String?

	public init() {}

	private var scoped: Bool { store.supports(.quickMessagesByProject) }

	/// Projects with no section yet, offered by "Add to a project".
	private var projectsWithoutMessages: [DeckProject] {
		store.projects.filter { project in !drafts.contains { $0.projectId == project.path } }
	}

	public var body: some View {
		NavigationStack {
			Form {
				Section {
					Text("Tap a message in the composer to send it. Text may contain tokens like [issue_url] or [branch-name]; deck fills them in when you send.")
						.font(.footnote)
						.foregroundStyle(.secondary)
				}
				ForEach(QuickMessage.scopes(drafts, projects: store.projects)) { scope in
					scopeSection(scope)
				}
				if scoped, !projectsWithoutMessages.isEmpty {
					Section {
						Menu {
							ForEach(projectsWithoutMessages) { project in
								Button(project.name) { drafts.append(QuickMessage(text: "", projectId: project.path)) }
							}
						} label: {
							Label("Add to a project", systemImage: "folder.badge.plus")
						}
					}
				}
				if let errorMessage {
					Section {
						Text(errorMessage).foregroundStyle(.red).font(.footnote)
					}
				}
			}
			.navigationTitle("Quick messages")
			.deckInlineNavigationTitle()
			.toolbar {
				ToolbarItem(placement: .cancellationAction) {
					Button("Cancel") { dismiss() }
				}
				#if os(iOS)
				ToolbarItem(placement: .topBarLeading) { EditButton() }
				#endif
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

	private func scopeSection(_ scope: QuickMessageScope) -> some View {
		Section {
			ForEach(Array(scope.ids.enumerated()), id: \.element) { index, id in
				if let message = binding(for: id) {
					row(message)
						// A macOS Form takes neither drag-to-reorder nor swipe-to-delete.
						.contextMenu { rowActions(scope, index: index) }
				}
			}
			.onDelete { offsets in
				let doomed = Set(offsets.map { scope.ids[$0] })
				drafts.removeAll { doomed.contains($0.id) }
			}
			.onMove { QuickMessage.move(&drafts, scope: scope.projectId, fromOffsets: $0, toOffset: $1) }
			Button {
				drafts.append(QuickMessage(text: "", projectId: scope.projectId))
			} label: {
				Label("Add message", systemImage: "plus")
			}
		} header: {
			if scoped { Text(scope.label) }
		}
	}

	@ViewBuilder
	private func rowActions(_ scope: QuickMessageScope, index: Int) -> some View {
		Button("Move Up", systemImage: "arrow.up") {
			QuickMessage.move(&drafts, scope: scope.projectId, fromOffsets: IndexSet(integer: index), toOffset: index - 1)
		}
		.disabled(index == 0)
		Button("Move Down", systemImage: "arrow.down") {
			QuickMessage.move(&drafts, scope: scope.projectId, fromOffsets: IndexSet(integer: index), toOffset: index + 2)
		}
		.disabled(index == scope.ids.count - 1)
		Button("Delete", systemImage: "trash", role: .destructive) {
			drafts.removeAll { $0.id == scope.ids[index] }
		}
	}

	private func row(_ message: Binding<QuickMessage>) -> some View {
		VStack(alignment: .leading, spacing: 6) {
			TextField("Label (optional)", text: Binding(
				get: { message.wrappedValue.label ?? "" },
				set: { message.wrappedValue.label = $0.isEmpty ? nil : $0 }))
			TextField("Message text", text: message.text, axis: .vertical)
				.lineLimit(1...6)
			if scoped { scopePicker(message.wrappedValue) }
		}
	}

	private func scopePicker(_ message: QuickMessage) -> some View {
		Picker("Show in", selection: Binding(
			get: { message.projectId ?? "" },
			set: { QuickMessage.setScope(&drafts, id: message.id, to: $0) })) {
			Text("Global").tag("")
			ForEach(store.projects) { project in
				Text(project.name).tag(project.path)
			}
			// A scope whose project is no longer registered stays selectable, so
			// opening the editor never silently rescopes the message.
			if let projectId = message.projectId, !store.projects.contains(where: { $0.path == projectId }) {
				Text(projectId).tag(projectId)
			}
		}
	}

	private func binding(for id: String) -> Binding<QuickMessage>? {
		guard let initial = drafts.first(where: { $0.id == id }) else { return nil }
		return Binding(
			get: { drafts.first { $0.id == id } ?? initial },
			set: { updated in
				if let current = drafts.firstIndex(where: { $0.id == id }) { drafts[current] = updated }
			})
	}

	private func save() async {
		isSaving = true
		errorMessage = nil
		let cleaned = drafts
			.map { QuickMessage(id: $0.id, label: $0.label, text: $0.text.trimmingCharacters(in: .whitespacesAndNewlines), projectId: $0.projectId) }
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
