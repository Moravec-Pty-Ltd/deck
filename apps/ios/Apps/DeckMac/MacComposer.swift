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
			guard case .success(let urls) = result else { return }
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
			.accessibilityIdentifier("sessionComposer")
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
		if let data = try? Data(contentsOf: url) { attach(data) }
	}

	private func attach(_ providers: [NSItemProvider]) async {
		for provider in providers {
			if let data = try? await provider.imageData() { attach(data) }
		}
	}

	/// PNG and JPEG go as they are; anything else (TIFF from a screenshot
	/// paste, HEIC) is re-encoded as PNG, which deck and the model both take.
	private func attach(_ data: Data) {
		guard images.count < Self.maxImages, !data.isEmpty else { return }
		if data.starts(with: [0x89, 0x50, 0x4E, 0x47]) {
			images.append(DeckImage(mediaType: "image/png", data: data.base64EncodedString()))
		} else if data.starts(with: [0xFF, 0xD8, 0xFF]) {
			images.append(DeckImage(mediaType: "image/jpeg", data: data.base64EncodedString()))
		} else if let image = NSImage(data: data), let png = Self.png(image) {
			images.append(DeckImage(mediaType: "image/png", data: png.base64EncodedString()))
		}
	}

	private static func png(_ image: NSImage) -> Data? {
		guard let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else { return nil }
		return rep.representation(using: .png, properties: [:])
	}
}

extension NSItemProvider {
	fileprivate func imageData() async throws -> Data? {
		try await withCheckedThrowingContinuation { continuation in
			_ = loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, error in
				if let error { continuation.resume(throwing: error) } else { continuation.resume(returning: data) }
			}
		}
	}
}
