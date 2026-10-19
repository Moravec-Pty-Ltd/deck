import SwiftUI
import DeckKit

/// The ⌘K palette: type to find a session or an action, arrow keys to move,
/// Return to pick. The caller decides what picking does; this only reports it.
public struct CommandPaletteView: View {
	let index: PaletteIndex
	let onPick: (PaletteItem) -> Void

	@Environment(\.dismiss) private var dismiss
	@State private var query = ""
	@State private var highlighted = 0
	@FocusState private var fieldFocused: Bool

	public init(index: PaletteIndex, onPick: @escaping (PaletteItem) -> Void) {
		self.index = index
		self.onPick = onPick
	}

	private var results: [PaletteItem] { index.results(for: query) }

	public var body: some View {
		NavigationStack {
			VStack(spacing: 0) {
				TextField("Search sessions and actions", text: $query)
					.textFieldStyle(.roundedBorder)
					.autocorrectionDisabled()
					.focused($fieldFocused)
					.onSubmit { pick(at: PaletteIndex.highlight(highlighted, count: results.count)) }
					.onKeyPress(.downArrow) { move(1) }
					.onKeyPress(.upArrow) { move(-1) }
					.accessibilityIdentifier("paletteField")
					.padding()
				resultList
			}
			.navigationTitle("Go to")
			#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .cancellationAction) {
					Button("Cancel") { dismiss() }
						.keyboardShortcut(.cancelAction)
				}
			}
		}
		.onAppear { fieldFocused = true }
		.onChange(of: query) { _, _ in highlighted = 0 }
		.onChange(of: results.map(\.id)) { _, ids in
			highlighted = PaletteIndex.highlight(highlighted, count: ids.count)
		}
	}

	private var resultList: some View {
		ScrollViewReader { proxy in
			List {
				ForEach(Array(results.enumerated()), id: \.element.id) { offset, item in
					Button {
						pick(at: offset)
					} label: {
						row(item)
							.frame(maxWidth: .infinity, alignment: .leading)
							.contentShape(Rectangle())
					}
					.buttonStyle(.plain)
					.listRowBackground(offset == highlighted ? Color.accentColor.opacity(0.18) : nil)
					.id(item.id)
				}
				if results.isEmpty {
					Text("Nothing matches that.")
						.font(.subheadline)
						.foregroundStyle(.secondary)
				}
			}
			.listStyle(.plain)
			.onChange(of: highlighted) { _, offset in
				guard results.indices.contains(offset) else { return }
				proxy.scrollTo(results[offset].id)
			}
		}
	}

	@ViewBuilder
	private func row(_ item: PaletteItem) -> some View {
		switch item {
		case .session(let session):
			SessionRow(session: session)
		case .action(let action):
			HStack(spacing: 12) {
				Image(systemName: action.systemImage)
					.frame(width: 24)
					.foregroundStyle(.secondary)
				Text(action.title)
				Spacer()
				if let shortcut = action.shortcut {
					Text(shortcut)
						.font(.caption.monospaced())
						.foregroundStyle(.secondary)
				}
			}
			.padding(.vertical, 4)
		}
	}

	private func move(_ by: Int) -> KeyPress.Result {
		highlighted = PaletteIndex.highlight(highlighted, by: by, count: results.count)
		return .handled
	}

	private func pick(at offset: Int) {
		guard results.indices.contains(offset) else { return }
		onPick(results[offset])
		dismiss()
	}
}
