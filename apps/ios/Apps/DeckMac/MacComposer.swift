import SwiftUI
import UniformTypeIdentifiers
import DeckKit
import DeckUI

/// The session's message field: quick messages, images (picked, pasted with
/// the paste control, or dropped on it), the text, and Send, under a working
/// status with Stop while a turn runs.
struct MacComposer: View {
	@Binding var draft: String
	@Binding var images: [DeckImage]
	let sending: Bool
	var working = false
	var onStop: () -> Void = {}
	var onSend: () -> Void
	var onQuickMessage: (String) -> Void
	var onManageQuickMessages: () -> Void
	/// Picks which project's quick messages are offered beside the global ones.
	var session: SessionDigest?

	@Environment(DeckStore.self) private var store
	@State private var importing = false
	@State private var dropTargeted = false
	@State private var attachFailures = 0
	@State private var pasteMonitor: Any?
	@FocusState private var fieldFocused: Bool
	@State private var windowIsKey = false
	@Environment(\.controlActiveState) private var activeState

	static let maxImages = 8

	var canSend: Bool {
		!sending && (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !images.isEmpty)
	}

	var body: some View {
		VStack(alignment: .leading, spacing: 6) {
			if working { status }
			if !images.isEmpty {
				ScrollView(.horizontal, showsIndicators: false) {
					HStack(spacing: 8) {
						ForEach(images) { thumbnail($0) }
					}
					.padding(.top, 4)
				}
				.frame(height: 60)
			}
			if attachFailures > 0 {
				Text("Couldn't attach that file")
					.font(.caption)
					.foregroundStyle(.secondary)
					.task(id: attachFailures) {
						guard (try? await Task.sleep(for: .seconds(4))) != nil else { return }
						attachFailures = 0
					}
			}
			HStack(alignment: .bottom, spacing: 8) {
				if store.supports(.quickMessages) { quickMessages }
				if store.supports(.images) { imageControls }
				field
				// ⌘Return is the Session menu's Send (DeckCommands).
				Button("Send", action: onSend)
					.disabled(!canSend)
			}
		}
		.padding()
		.fileImporter(isPresented: $importing, allowedContentTypes: [.image], allowsMultipleSelection: true) { result in
			guard case .success(let urls) = result else { attachFailures += 1; return }
			for url in urls { attach(fileAt: url) }
		}
		.dropDestination(for: Data.self) { items, _ in
			guard store.supports(.images) else { return false }
			for data in items { attach(data) }
			return !items.isEmpty
		} isTargeted: { dropTargeted = $0 }
		.overlay {
			if dropTargeted {
				RoundedRectangle(cornerRadius: DeckStyle.Radius.card)
					.stroke(Color.accentColor, lineWidth: 2)
					.padding(4)
			}
		}
	}

	private var status: some View {
		HStack {
			WorkingLabel()
			Spacer()
			// ⌘. is the Session menu's Stop (DeckCommands).
			Button("Stop", systemImage: "stop.circle", action: onStop)
				.controlSize(.small)
				.help("Stop this turn (⌘.)")
		}
	}

	private var field: some View {
		TextField("Message", text: $draft, axis: .vertical)
			.textFieldStyle(.plain)
			.lineLimit(1...8)
			.padding(8)
			.background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: DeckStyle.Radius.control))
			.overlay(
				RoundedRectangle(cornerRadius: DeckStyle.Radius.control)
					.stroke(Color(nsColor: .separatorColor), lineWidth: 0.5))
			.onSubmit { if canSend { onSend() } }
			.focused($fieldFocused)
			.accessibilityIdentifier("sessionComposer")
			// The monitor sees every window's keys; only the key window's composer answers.
			.onChange(of: activeState, initial: true) { windowIsKey = activeState == .key }
			// The field editor takes ⌘V before onPasteCommand and drops an image,
			// so an image on the clipboard is caught on the way in.
			.onAppear {
				guard pasteMonitor == nil else { return }
				pasteMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { pasteImage($0) ? nil : $0 }
			}
			.onDisappear {
				if let pasteMonitor { NSEvent.removeMonitor(pasteMonitor) }
				pasteMonitor = nil
			}
	}

	private var quickMessages: some View {
		let offered = store.quickMessages(for: session)
		return Menu {
			if offered.isEmpty {
				Text("No quick messages")
			}
			ForEach(offered) { message in
				Button(message.displayLabel) { onQuickMessage(message.text) }
			}
			Divider()
			Button("Manage…", action: onManageQuickMessages)
		} label: {
			Image(systemName: "text.append")
		}
		.menuIndicator(.hidden)
		.fixedSize()
		.help("Quick messages")
	}

	@ViewBuilder
	private var imageControls: some View {
		Button {
			importing = true
		} label: {
			Image(systemName: "photo.on.rectangle")
		}
		.help("Attach images")
		.disabled(images.count >= Self.maxImages)
		PasteButton(supportedContentTypes: [.image]) { providers in
			Task { await attach(providers) }
		}
		.labelStyle(.iconOnly)
		.help("Paste an image")
	}

	private func thumbnail(_ image: DeckImage) -> some View {
		ZStack(alignment: .topTrailing) {
			if let data = Data(base64Encoded: image.data), let platform = PlatformImage(data: data) {
				Image(platformImage: platform)
					.resizable()
					.scaledToFill()
					.frame(width: 52, height: 52)
					.clipShape(RoundedRectangle(cornerRadius: DeckStyle.Radius.control))
			}
			Button {
				images.removeAll { $0.id == image.id }
			} label: {
				Image(systemName: "xmark.circle.fill")
					.foregroundStyle(.white, .black.opacity(0.6))
			}
			.buttonStyle(.plain)
			.offset(x: 4, y: -4)
			.accessibilityLabel("Remove image")
		}
	}

	private func attach(fileAt url: URL) {
		let scoped = url.startAccessingSecurityScopedResource()
		defer { if scoped { url.stopAccessingSecurityScopedResource() } }
		guard let data = try? Data(contentsOf: url) else { attachFailures += 1; return }
		attach(data)
	}

	private func attach(_ providers: [NSItemProvider]) async {
		for provider in providers where images.count < Self.maxImages {
			if let image = await ImagePaste.image(from: provider) { images.append(image) } else { attachFailures += 1 }
		}
	}

	/// ⌘V in the field with an image and no rich text on the clipboard
	/// (the same rule as the phone's field).
	private func pasteImage(_ event: NSEvent) -> Bool {
		guard fieldFocused, windowIsKey, store.supports(.images),
			event.modifierFlags.intersection([.command, .shift, .option, .control]) == .command,
			event.charactersIgnoringModifiers == "v" else { return false }
		let board = NSPasteboard.general
		guard board.availableType(from: [.rtf, .rtfd]) == nil,
			let type = board.types?.first(where: { UTType($0.rawValue)?.conforms(to: .image) == true }) else { return false }
		if let data = board.data(forType: type) { attach(data) } else { attachFailures += 1 }
		return true
	}

	private func attach(_ data: Data) {
		guard images.count < Self.maxImages else { return }
		if let image = ImagePaste.image(from: data) { images.append(image) } else { attachFailures += 1 }
	}
}
