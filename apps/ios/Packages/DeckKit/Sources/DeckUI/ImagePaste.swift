import Foundation
import UniformTypeIdentifiers
import DeckKit
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// Turns a pasted, dropped or picked image into an attachment, whatever form
/// the clipboard offers it in.
public enum ImagePaste {
	/// PNG and JPEG go as they are; anything else (HEIC, TIFF, GIF) is
	/// re-encoded as PNG, which deck and the model both take.
	public static func image(from data: Data) -> DeckImage? {
		if data.starts(with: [0x89, 0x50, 0x4E, 0x47]) {
			return DeckImage(mediaType: "image/png", data: data.base64EncodedString())
		}
		if data.starts(with: [0xFF, 0xD8, 0xFF]) {
			return DeckImage(mediaType: "image/jpeg", data: data.base64EncodedString())
		}
		guard !data.isEmpty, let image = PlatformImage(data: data), let png = png(image) else { return nil }
		return DeckImage(mediaType: "image/png", data: png.base64EncodedString())
	}

	public static func hasImage(_ provider: NSItemProvider) -> Bool {
		imageType(of: provider) != nil || provider.canLoadObject(ofClass: PlatformImage.self)
	}

	/// Most copies (Photos, Safari, a saved screenshot) offer typed data or a
	/// file rather than a ready image object, so the data comes first and the
	/// object is the fallback.
	public static func image(from provider: NSItemProvider) async -> DeckImage? {
		if let type = imageType(of: provider), let data = await data(from: provider, type: type),
			let image = image(from: data) {
			return image
		}
		guard provider.canLoadObject(ofClass: PlatformImage.self) else { return nil }
		let object: PlatformImage? = await withCheckedContinuation { continuation in
			_ = provider.loadObject(ofClass: PlatformImage.self) { object, _ in
				continuation.resume(returning: object as? PlatformImage)
			}
		}
		guard let object, let png = png(object) else { return nil }
		return DeckImage(mediaType: "image/png", data: png.base64EncodedString())
	}

	private static func imageType(of provider: NSItemProvider) -> String? {
		provider.registeredTypeIdentifiers.first { UTType($0)?.conforms(to: .image) == true }
	}

	private static func data(from provider: NSItemProvider, type: String) async -> Data? {
		await withCheckedContinuation { continuation in
			_ = provider.loadDataRepresentation(forTypeIdentifier: type) { data, _ in
				continuation.resume(returning: data)
			}
		}
	}

	private static func png(_ image: PlatformImage) -> Data? {
		#if canImport(UIKit)
		// Drawn rather than pngData(), which drops a photo's EXIF orientation.
		let format = UIGraphicsImageRendererFormat()
		format.scale = image.scale
		return UIGraphicsImageRenderer(size: image.size, format: format).pngData { _ in image.draw(at: .zero) }
		#else
		guard let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else { return nil }
		return rep.representation(using: .png, properties: [:])
		#endif
	}
}
