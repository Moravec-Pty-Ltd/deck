import QuickLook
import SwiftUI
import DeckKit

/// The local files a message mentions, under its text: images as previews
/// that open full size (with the message's other images a swipe away), other
/// files as chips that fetch the file and open it in Quick Look. Only files
/// deck can serve show up; a mention of anything else stays plain text.
struct FileAttachments: View {
	let text: String
	let viewModel: SessionDetailViewModel

	@State private var files: [FileInfo] = []
	@State private var gallery: GalleryOpening?
	@State private var preview: URL?
	@State private var fetching: String?

	private var images: [FileInfo] { files.filter(\.image) }
	private var others: [FileInfo] { files.filter { !$0.image } }

	var body: some View {
		VStack(alignment: .leading, spacing: 8) {
			if !images.isEmpty {
				ScrollView(.horizontal, showsIndicators: false) {
					HStack(spacing: 8) {
						ForEach(Array(images.enumerated()), id: \.element.id) { index, file in
							Button {
								gallery = GalleryOpening(images: images, index: index)
							} label: {
								FileThumbnail(file: file, viewModel: viewModel)
							}
							.buttonStyle(.plain)
							.accessibilityLabel("Open \(file.name)")
						}
					}
				}
			}
			ForEach(others) { file in
				Button {
					open(file)
				} label: {
					HStack(spacing: 6) {
						if fetching == file.path {
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
					.background(Color(.tertiarySystemFill), in: Capsule())
				}
				.buttonStyle(.plain)
				.disabled(fetching != nil)
				.accessibilityLabel("Open \(file.name)")
			}
		}
		.task(id: text) {
			let paths = MessageFiles.paths(in: text)
			files = paths.isEmpty ? [] : await viewModel.files(for: paths)
		}
		.fullScreenCover(item: $gallery) { opening in
			ImageGallery(images: opening.images, index: opening.index, viewModel: viewModel)
		}
		.quickLookPreview($preview)
	}

	private func open(_ file: FileInfo) {
		fetching = file.path
		Task {
			preview = await viewModel.localCopy(of: file)
			fetching = nil
		}
	}
}

struct GalleryOpening: Identifiable {
	let id = UUID()
	let images: [FileInfo]
	let index: Int
}

/// A mentioned image at preview size, fetched through the authenticated
/// client like message attachments are.
struct FileThumbnail: View {
	let file: FileInfo
	let viewModel: SessionDetailViewModel

	@State private var image: UIImage?
	@State private var failed = false

	var body: some View {
		Group {
			if let image {
				Image(uiImage: image)
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
		.clipShape(RoundedRectangle(cornerRadius: 8))
		.overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(.separator), lineWidth: 0.5))
		// Copy without opening the image first: on a Mac the point of seeing a
		// screenshot in the transcript is usually to paste it somewhere else.
		.contextMenu {
			if let image {
				Button {
					ImageClipboard.copy(image)
				} label: {
					Label("Copy image", systemImage: "doc.on.doc")
				}
				ShareLink(item: Image(uiImage: image), preview: SharePreview(file.name, image: Image(uiImage: image))) {
					Label("Share…", systemImage: "square.and.arrow.up")
				}
			}
		}
		.task(id: file.path) {
			guard image == nil else { return }
			if let data = await viewModel.fileData(path: file.path), let loaded = UIImage(data: data) {
				image = loaded
			} else {
				failed = true
			}
		}
	}
}

/// A message's images full size, one per page: swipe or the arrows move
/// between them, a pinch zooms, and the share button hands the image on.
struct ImageGallery: View {
	let images: [FileInfo]
	@State var index: Int
	let viewModel: SessionDetailViewModel

	@Environment(\.dismiss) private var dismiss
	@State private var loaded: [String: UIImage] = [:]

	private var current: FileInfo { images[index] }

	var body: some View {
		ZStack(alignment: .top) {
			Color.black.ignoresSafeArea()
			TabView(selection: $index) {
				ForEach(Array(images.enumerated()), id: \.element.id) { i, file in
					ZoomableImage(image: loaded[file.path])
						.tag(i)
						.task(id: file.path) {
							guard loaded[file.path] == nil, let data = await viewModel.fileData(path: file.path) else { return }
							loaded[file.path] = UIImage(data: data)
						}
				}
			}
			.tabViewStyle(.page(indexDisplayMode: images.count > 1 ? .automatic : .never))
			.ignoresSafeArea()
			HStack(spacing: 8) {
				Button("Done") { dismiss() }
					.accessibilityLabel("Close")
				Spacer()
				VStack(spacing: 2) {
					Text(current.name).lineLimit(1)
					if images.count > 1 {
						Text("\(index + 1) of \(images.count)").font(.caption).foregroundStyle(.secondary)
					}
				}
				.font(.subheadline)
				Spacer()
				if let image = loaded[current.path] {
					Button {
						ImageClipboard.copy(image)
					} label: {
						Image(systemName: "doc.on.doc")
					}
					.accessibilityLabel("Copy \(current.name)")
					ShareLink(item: Image(uiImage: image), preview: SharePreview(current.name, image: Image(uiImage: image))) {
						Image(systemName: "square.and.arrow.up")
					}
					.accessibilityLabel("Share \(current.name)")
				} else {
					Image(systemName: "square.and.arrow.up").hidden()
				}
			}
			.padding(.horizontal)
			.padding(.vertical, 8)
			.background(.ultraThinMaterial)
		}
		// Dark for the gallery alone; preferredColorScheme would flip the whole
		// scene behind it.
		.environment(\.colorScheme, .dark)
		.statusBarHidden()
	}
}

/// One gallery page: the image fit to the screen, a pinch to zoom, a double
/// tap to zoom in or back out.
struct ZoomableImage: View {
	let image: UIImage?

	@State private var scale: CGFloat = 1
	@State private var pinch: CGFloat = 1

	var body: some View {
		Group {
			if let image {
				ScrollView([.horizontal, .vertical], showsIndicators: false) {
					Image(uiImage: image)
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
/// rather than a file reference.
enum ImageClipboard {
	static func copy(_ image: UIImage) {
		// PNG as well as the image itself: some destinations take only data,
		// and a screenshot pasted as JPEG loses its crispness.
		var items: [String: Any] = ["public.image": image]
		if let png = image.pngData() { items["public.png"] = png }
		UIPasteboard.general.items = [items]
	}
}
