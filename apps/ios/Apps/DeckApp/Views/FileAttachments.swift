import QuickLook
import SwiftUI
import DeckKit
import DeckUI

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
								FileThumbnail(file: file) { await viewModel.fileData(path: file.path) }
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
					FileChip(file: file, fetching: fetching == file.path)
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

/// A message's images full size, one per page: swipe or the arrows move
/// between them, a pinch zooms, and the share button hands the image on.
struct ImageGallery: View {
	let images: [FileInfo]
	@State var index: Int
	let viewModel: SessionDetailViewModel

	@Environment(\.dismiss) private var dismiss
	@State private var loaded: [String: PlatformImage] = [:]

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
							loaded[file.path] = PlatformImage(data: data)
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
					ShareLink(item: Image(platformImage: image), preview: SharePreview(current.name, image: Image(platformImage: image))) {
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
