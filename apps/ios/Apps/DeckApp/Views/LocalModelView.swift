import DeckKit
import DeckLocalModel
import SwiftUI

/// Choosing and downloading the model the operator thinks with (deck#239).
///
/// The operator ran on Apple's on-device model, whose 4,096-token context meant
/// every tool result was cut to 2,000 characters and it refused instructions
/// about its own output. This screen swaps it for a model downloaded from
/// Hugging Face: tens of thousands of tokens, and it does what it is told.
///
/// Nothing is downloaded until asked. The shortlist is a starting point, not a
/// catalogue: any MLX-format repo can be typed in, which is the same thing the
/// shortlist entries are.
struct LocalModelView: View {
	@State private var store = LocalModelStore.shared
	@State private var typed = ""
	@State private var typedProblem: String?
	@State private var confirmDelete = false

	private var support: LocalModelStore.Support { LocalModelStore.support }

	var body: some View {
		Form {
			if let reason = support.reason {
				Section {
					Text(reason).font(.footnote).foregroundStyle(.secondary)
				}
			}

			Section {
				Button {
					choose("")
				} label: {
					row(
						name: "Apple on-device",
						detail: "Free and always there. Its context is 4,096 tokens, so it only ever hears the first 2,000 characters of a reply.",
						size: nil,
						chosen: store.chosenId.isEmpty)
				}
			} header: {
				Text("Model")
			} footer: {
				Text("What the operator thinks with. Changing it starts the conversation again.")
			}

			Section {
				ForEach(LocalModelCatalogue.suggested) { option in
					Button {
						choose(option.id)
					} label: {
						row(
							name: option.name,
							detail: option.note,
							size: option.size,
							chosen: store.chosenId == option.id)
					}
					.disabled(support != .supported)
				}
			} header: {
				Text("Downloaded")
			} footer: {
				Text("Each of these calls tools and has a context window in the tens of thousands. Downloaded over the network once, then kept on the device.")
			}

			// A chosen model that is not on the shortlist still needs a row, or
			// the screen would show nothing selected while the operator uses it.
			if !store.chosenId.isEmpty, LocalModelCatalogue.option(for: store.chosenId) == nil {
				Section("Chosen") {
					row(
						name: LocalModelCatalogue.displayName(for: store.chosenId),
						detail: store.chosenId,
						size: nil,
						chosen: true)
				}
			}

			if support == .supported {
				Section {
					TextField("owner/name", text: $typed)
						.textInputAutocapitalization(.never)
						.autocorrectionDisabled()
						.font(.body.monospaced())
						.accessibilityIdentifier("modelRepoField")
					if let typedProblem {
						Text(typedProblem).font(.footnote).foregroundStyle(.red)
					}
					Button("Use this model") { useTyped() }
						.disabled(typed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
				} header: {
					Text("Any other model")
				} footer: {
					Text("A Hugging Face repo whose weights are in MLX format — an mlx-community one, or your own conversion. GGUF will not load.")
				}
			}

			if !store.chosenId.isEmpty, support == .supported {
				Section("Status") { status }
			}
		}
		.navigationTitle("Operator model")
		.navigationBarTitleDisplayMode(.inline)
		.task { await store.refresh() }
		.onChange(of: store.chosenId) { _, _ in
			// The operator holds the brain, so it is the one that has to be told.
			OperatorController.shared.adoptLocalModel()
		}
		.onChange(of: store.state) { _, _ in OperatorController.shared.adoptLocalModel() }
		.confirmationDialog("Delete the downloaded weights?", isPresented: $confirmDelete, titleVisibility: .visible) {
			Button("Delete", role: .destructive) { Task { await store.delete() } }
		} message: {
			Text("The operator goes back to Apple's on-device model. The weights download again if you choose this model later.")
		}
	}

	@ViewBuilder
	private func row(name: String, detail: String, size: String?, chosen: Bool) -> some View {
		HStack(alignment: .top, spacing: 10) {
			Image(systemName: chosen ? "largecircle.fill.circle" : "circle")
				.foregroundStyle(chosen ? Color.accentColor : .secondary)
				.accessibilityHidden(true)
			VStack(alignment: .leading, spacing: 2) {
				HStack(spacing: 6) {
					Text(name).font(.body)
					if let size {
						Text(size).font(.caption).foregroundStyle(.secondary)
					}
				}
				Text(detail).font(.caption).foregroundStyle(.secondary)
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.contentShape(Rectangle())
		.accessibilityAddTraits(chosen ? [.isSelected] : [])
	}

	@ViewBuilder
	private var status: some View {
		switch store.state {
		case .notDownloaded:
			let size = LocalModelCatalogue.option(for: store.chosenId)?.size
			Button {
				Task { await store.download() }
			} label: {
				Label(size.map { "Download (\($0))" } ?? "Download", systemImage: "arrow.down.circle")
			}
			Text("Until it is downloaded the operator keeps using Apple's model.")
				.font(.caption)
				.foregroundStyle(.secondary)

		case .downloading(let fraction):
			VStack(alignment: .leading, spacing: 6) {
				// Indeterminate until the first figure arrives: a bar pinned at
				// zero reads as stuck rather than starting.
				if fraction > 0 {
					ProgressView(value: fraction)
					Text("\(Int(fraction * 100))%").font(.caption).foregroundStyle(.secondary)
				} else {
					ProgressView()
					Text("Starting").font(.caption).foregroundStyle(.secondary)
				}
			}

		case .ready:
			Label("Ready", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
			if let bytes = store.downloadedBytes {
				Text("\(Self.readable(bytes)) on this device")
					.font(.caption)
					.foregroundStyle(.secondary)
			}
			Button("Free the memory") { Task { await store.unload() } }
			Button("Delete the weights", role: .destructive) { confirmDelete = true }
			Text("The operator is thinking with this model. Freeing the memory keeps the weights; deleting them does not.")
				.font(.caption)
				.foregroundStyle(.secondary)

		case .failed(let reason):
			Label(reason, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
			Button("Try again") { Task { await store.download() } }
		}
	}

	/// Bytes as a size someone reads, which for a model is one decimal of a
	/// gigabyte or whole megabytes.
	private static func readable(_ bytes: Int64) -> String {
		let gb = Double(bytes) / 1_000_000_000
		return gb < 1 ? String(format: "%.0f MB", gb * 1000) : String(format: "%.1f GB", gb)
	}

	private func choose(_ id: String) {
		typedProblem = nil
		store.choose(id)
	}

	private func useTyped() {
		if let problem = LocalModelCatalogue.repoProblem(typed) {
			typedProblem = problem
			return
		}
		typedProblem = nil
		store.choose(typed)
		typed = ""
	}
}
