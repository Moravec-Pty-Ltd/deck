import Foundation
import UniformTypeIdentifiers
import DeckKit

/// Turning what the share sheet hands over into files deck can take.
///
/// The sheet gives item providers, not bytes, and each one has to be asked for
/// its data. They are loaded concurrently and the order the sheet listed them
/// is kept, because a share of three screenshots reads better in order.
enum ShareItems {
	/// Everything shareable in the extension's input, already read.
	static func load(from providers: [NSItemProvider]) async -> [SharedFile] {
		await withTaskGroup(of: (Int, SharedFile?).self) { group in
			for (index, provider) in providers.prefix(ShareLimits.maxFiles).enumerated() {
				group.addTask { (index, await file(from: provider)) }
			}
			var found: [(Int, SharedFile)] = []
			for await (index, file) in group {
				if let file { found.append((index, file)) }
			}
			return found.sorted { $0.0 < $1.0 }.map(\.1)
		}
	}

	/// One provider's contents. A file URL is read from disk; text and a web URL
	/// become small files of their own, so a shared link arrives as something
	/// the agent can open rather than being silently dropped.
	private static func file(from provider: NSItemProvider) async -> SharedFile? {
		if let url = await loadURL(provider), url.isFileURL {
			guard let data = try? Data(contentsOf: url) else { return nil }
			return SharedFile(name: url.lastPathComponent, data: data)
		}
		if let data = await loadData(provider) {
			return SharedFile(name: suggestedName(provider), data: data)
		}
		if let url = await loadURL(provider) {
			return SharedFile(name: "shared-link.txt", data: Data(url.absoluteString.utf8))
		}
		if let text = await loadText(provider) {
			return SharedFile(name: "shared-note.txt", data: Data(text.utf8))
		}
		return nil
	}

	/// The sheet's own name for the item when it has one, else a name built from
	/// the type so the extension never writes an unnamed file.
	private static func suggestedName(_ provider: NSItemProvider) -> String {
		if let name = provider.suggestedName, !name.isEmpty { return name }
		let ext = provider.registeredContentTypes.first?.preferredFilenameExtension ?? "bin"
		return "shared.\(ext)"
	}

	private static func loadURL(_ provider: NSItemProvider) async -> URL? {
		await withCheckedContinuation { continuation in
			guard provider.canLoadObject(ofClass: URL.self) else {
				return continuation.resume(returning: nil)
			}
			_ = provider.loadObject(ofClass: URL.self) { url, _ in
				continuation.resume(returning: url)
			}
		}
	}

	private static func loadText(_ provider: NSItemProvider) async -> String? {
		await withCheckedContinuation { continuation in
			guard provider.canLoadObject(ofClass: String.self) else {
				return continuation.resume(returning: nil)
			}
			_ = provider.loadObject(ofClass: String.self) { text, _ in
				continuation.resume(returning: text)
			}
		}
	}

	/// The first registered type that carries bytes. Asked for by type rather
	/// than guessing, so a screenshot arrives as a PNG and a PDF as a PDF.
	private static func loadData(_ provider: NSItemProvider) async -> Data? {
		let types = provider.registeredContentTypes.filter { $0.conforms(to: .data) && $0 != .url && $0 != .fileURL }
		for type in types {
			if let data = await loadData(provider, type: type) { return data }
		}
		return nil
	}

	private static func loadData(_ provider: NSItemProvider, type: UTType) async -> Data? {
		await withCheckedContinuation { continuation in
			provider.loadDataRepresentation(forTypeIdentifier: type.identifier) { data, _ in
				continuation.resume(returning: data)
			}
		}
	}
}
