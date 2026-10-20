import SwiftUI
import DeckKit

/// A project's dev servers, shared setup steps and files copied from the main
/// checkout, mirroring the web's DevConfigForm. Saves the whole `dev` config;
/// the server validates it and its refusal is shown as it was sent.
public struct DevConfigEditor: View {
	let project: DeckProject

	@Environment(DeckStore.self) private var store
	@State private var draft = DevConfigDraft()
	@State private var original = DevConfig()
	@State private var loaded = false
	@State private var isSaving = false
	@State private var errorMessage: String?

	public init(project: DeckProject) {
		self.project = project
	}

	public var body: some View {
		Form {
			if let errorMessage {
				Section { Text(errorMessage).foregroundStyle(.red).font(.footnote) }
			}
			serversSection
			setupSection
			copySection
		}
		.navigationTitle("Dev servers")
		.deckInlineNavigationTitle()
		.toolbar {
			#if os(iOS)
			ToolbarItem(placement: .topBarLeading) { EditButton() }
			#endif
			ToolbarItem(placement: .confirmationAction) {
				Button(isSaving ? "Saving…" : "Save") { Task { await save() } }
					.disabled(!loaded || isSaving || draft.config == original)
					.accessibilityIdentifier("saveDevConfig")
			}
		}
		.task { load() }
	}

	private var serversSection: some View {
		Section {
			ForEach($draft.servers) { $server in
				NavigationLink {
					DevServerEditor(server: $server)
				} label: {
					VStack(alignment: .leading, spacing: 2) {
						Text(server.name.isEmpty ? "Unnamed server" : server.name)
						if !server.run.isEmpty {
							Text(server.run).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
						}
					}
				}
			}
			.onDelete { draft.servers.remove(atOffsets: $0) }
			.onMove { draft.servers.move(fromOffsets: $0, toOffset: $1) }
			Button { draft.servers.append(DevServerDraft()) } label: { Label("Add server", systemImage: "plus") }
		} header: {
			Text("Servers")
		} footer: {
			Text("Steps and run commands can use $DECK_WORKTREE (the session's worktree) and $DECK_MAIN (the project's main checkout).")
		}
	}

	private var setupSection: some View {
		Section {
			DevStepRows(steps: $draft.setup)
		} header: {
			Text("Shared setup")
		} footer: {
			Text("Runs in order before any server starts. A step without a label and command is not saved.")
		}
	}

	private var copySection: some View {
		Section {
			ForEach($draft.copyFromMain) { $entry in
				TextField("apps/api/.env.local", text: $entry.path)
					.deckPlainInput()
					.font(.body.monospaced())
			}
			.onDelete { draft.copyFromMain.remove(atOffsets: $0) }
			.onMove { draft.copyFromMain.move(fromOffsets: $0, toOffset: $1) }
			Button { draft.copyFromMain.append(DevPathDraft()) } label: { Label("Add file", systemImage: "plus") }
		} header: {
			Text("Copy from main checkout")
		} footer: {
			Text("Copied into each new worktree, for files git does not track.")
		}
	}

	private func load() {
		// Once: coming back from a server's screen keeps unsaved edits.
		guard !loaded else { return }
		original = store.projectDetails[project.path]?.dev ?? DevConfig()
		draft = DevConfigDraft(original)
		loaded = true
	}

	private func save() async {
		isSaving = true
		errorMessage = nil
		do {
			let config = draft.config
			try await store.saveDevConfig(path: project.path, dev: config)
			original = store.projectDetails[project.path]?.dev ?? config
			draft = DevConfigDraft(original)
		} catch {
			errorMessage = DeckError.message(for: error)
		}
		isSaving = false
	}
}

/// One server: its command, ready pattern, ports and own setup steps.
struct DevServerEditor: View {
	@Binding var server: DevServerDraft

	var body: some View {
		Form {
			Section("Server") {
				TextField("Name (web)", text: $server.name)
					.deckPlainInput()
				TextField("Run (pnpm dev)", text: $server.run, axis: .vertical)
					.deckPlainInput()
					.font(.body.monospaced())
				TextField("Folder (.)", text: $server.cwd)
					.deckPlainInput()
					.font(.body.monospaced())
			}
			Section {
				TextField(#"Local:\s+(http\S+)"#, text: $server.readyPattern)
					.deckPlainInput()
					.font(.body.monospaced())
			} header: {
				Text("Ready pattern")
			} footer: {
				Text("A regex over the server's output. Its first capture group, if any, is the preview link.")
			}
			portsSection
			Section {
				DevStepRows(steps: $server.setup)
			} header: {
				Text("Server setup")
			} footer: {
				Text("Runs after the shared setup, before this server starts.")
			}
		}
		.navigationTitle(server.name.isEmpty ? "Server" : server.name)
		.deckInlineNavigationTitle()
		#if os(iOS)
		.toolbar { EditButton() }
		#endif
	}

	private var portsSection: some View {
		Section {
			ForEach($server.ports) { $port in
				HStack {
					TextField("Port", text: $port.port)
						.font(.body.monospaced())
						.frame(maxWidth: 80)
						#if os(iOS)
						.keyboardType(.numberPad)
						#endif
					TextField("Label", text: $port.label)
					Toggle("Primary", isOn: Binding(
						get: { port.primary },
						set: { server.setPrimary(port.id, $0) }))
						.fixedSize()
				}
			}
			.onDelete { server.ports.remove(atOffsets: $0) }
			.onMove { server.ports.move(fromOffsets: $0, toOffset: $1) }
			Button { server.ports.append(DevPortDraft()) } label: { Label("Add port", systemImage: "plus") }
		} header: {
			Text("Ports")
		} footer: {
			if server.ports.contains(where: { $0.number == nil }) {
				Text("A port outside 1 to 65535 is not saved.").foregroundStyle(.red)
			} else {
				Text("Ready once every port listens. The primary port is the preview link when the pattern captures none.")
			}
		}
	}
}

/// Ordered setup steps: a label, a command and an optional folder each.
struct DevStepRows: View {
	@Binding var steps: [DevStepDraft]

	var body: some View {
		ForEach($steps) { $step in
			VStack(alignment: .leading) {
				TextField("Label", text: $step.label)
				TextField("Run (pnpm install)", text: $step.run, axis: .vertical)
					.deckPlainInput()
					.font(.body.monospaced())
				TextField("Folder (.)", text: $step.cwd)
					.deckPlainInput()
					.font(.caption.monospaced())
			}
		}
		.onDelete { steps.remove(atOffsets: $0) }
		.onMove { steps.move(fromOffsets: $0, toOffset: $1) }
		Button { steps.append(DevStepDraft()) } label: { Label("Add step", systemImage: "plus") }
	}
}
