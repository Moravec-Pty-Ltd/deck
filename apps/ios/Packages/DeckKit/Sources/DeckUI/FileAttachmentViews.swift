import SwiftUI
import DeckKit
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// A mentioned image at preview size, fetched through the authenticated
/// client like message attachments are.
public struct FileThumbnail: View {
	let file: FileInfo
	let load: () async -> Data?

	@State private var image: PlatformImage?
	@State private var failed = false

	public init(file: FileInfo, load: @escaping () async -> Data?) {
		self.file = file
		self.load = load
	}

	public var body: some View {
		Group {
			if let image {
				Image(platformImage: image)
					.resizable()
					.scaledToFill()
			} else if failed {
				Image(systemName: "photo")
					.foregroundStyle(.secondary)
			} else {
				ProgressView().controlSize(.small)
			}
		}
		.frame(width: 160, height: 120)
		.clipShape(RoundedRectangle(cornerRadius: DeckStyle.Radius.control))
		.overlay(RoundedRectangle(cornerRadius: DeckStyle.Radius.control).stroke(Color.deckSeparator, lineWidth: 0.5))
		// Copy without opening the image first: on a Mac the point of seeing a
		// screenshot in the transcript is usually to paste it somewhere else.
		.contextMenu {
			if let image {
				Button {
					ImageClipboard.copy(image)
				} label: {
					Label("Copy image", systemImage: "doc.on.doc")
				}
				ShareLink(item: Image(platformImage: image), preview: SharePreview(file.name, image: Image(platformImage: image))) {
					Label("Share…", systemImage: "square.and.arrow.up")
				}
			}
		}
		.task(id: file.path) {
			guard image == nil else { return }
			if let data = await load(), let loaded = PlatformImage(data: data) {
				image = loaded
			} else {
				failed = true
			}
		}
	}
}

/// A mentioned file that is not an image: its name and size, or a spinner
/// while it is fetched for Quick Look.
public struct FileChip: View {
	let file: FileInfo
	let fetching: Bool

	public init(file: FileInfo, fetching: Bool) {
		self.file = file
		self.fetching = fetching
	}

	public var body: some View {
		HStack(spacing: 6) {
			if fetching {
				ProgressView().controlSize(.mini)
			} else {
				Image(systemName: "doc")
			}
			Text(file.name).lineLimit(1)
			Text(MessageFiles.formatBytes(file.size)).foregroundStyle(.secondary)
		}
		.font(.caption)
		.padding(.horizontal, 8)
		.padding(.vertical, 5)
		.background(Color.deckTertiaryFill, in: Capsule())
	}
}

/// One gallery page: the image fit to the screen, a pinch to zoom, a double
/// tap to zoom in or back out.
public struct ZoomableImage: View {
	let image: PlatformImage?

	@State private var scale: CGFloat = 1
	@State private var pinch: CGFloat = 1

	public init(image: PlatformImage?) {
		self.image = image
	}

	public var body: some View {
		Group {
			if let image {
				ScrollView([.horizontal, .vertical], showsIndicators: false) {
					Image(platformImage: image)
						.resizable()
						.scaledToFit()
						.containerRelativeFrame([.horizontal, .vertical]) { length, _ in length * scale * pinch }
				}
				.scrollDisabled(scale * pinch <= 1)
				.gesture(
					MagnifyGesture()
						.onChanged { pinch = $0.magnification }
						.onEnded { _ in
							scale = min(max(scale * pinch, 1), 5)
							pinch = 1
						}
				)
				.onTapGesture(count: 2) {
					withAnimation { scale = scale > 1 ? 1 : 2.5 }
				}
			} else {
				ProgressView().tint(.white)
			}
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity)
	}
}

/// Putting an image on the clipboard. UIPasteboard covers iOS, iPadOS and Mac
/// Catalyst alike, so ⌘V on a Mac and Paste on a phone both get the picture
/// rather than a file reference; AppKit covers a plain macOS build.
public enum ImageClipboard {
	public static func copy(_ image: PlatformImage) {
		#if canImport(UIKit)
		// PNG as well as the image itself: some destinations take only data,
		// and a screenshot pasted as JPEG loses its crispness.
		var items: [String: Any] = ["public.image": image]
		if let png = image.pngData() { items["public.png"] = png }
		UIPasteboard.general.items = [items]
		#else
		NSPasteboard.general.clearContents()
		NSPasteboard.general.writeObjects([image])
		#endif
	}
}
