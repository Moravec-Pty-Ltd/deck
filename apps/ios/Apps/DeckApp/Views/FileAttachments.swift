import AVKit
import QuickLook
import SwiftUI
import DeckKit
import DeckUI

/// The local files a message mentions, under its text: images as previews
/// that open full size (with the message's other images a swipe away), other
/// files as chips that fetch the file and open it: a video in a player,
/// anything else in Quick Look. Only files
/// deck can serve show up; a mention of anything else stays plain text.
struct FileAttachments: View {
	let text: String
	let viewModel: SessionDetailViewModel

	@State private var files: [FileInfo] = []
	@State private var gallery: GalleryOpening?
	@State private var preview: URL?
	@State private var video: VideoOpening?
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
		.filePreviews(gallery: $gallery, video: $video, preview: $preview, viewModel: viewModel)
	}

	private func open(_ file: FileInfo) {
		fetching = file.path
		Task {
			_ = await viewModel.openFile(file, video: $video, preview: $preview)
			fetching = nil
		}
	}
}

extension SessionDetailViewModel {
	/// Fetch a file and open it: a video in the player, anything else in Quick
	/// Look. False when deck would not serve it.
	func openFile(_ file: FileInfo, video: Binding<VideoOpening?>, preview: Binding<URL?>) async -> Bool {
		// shortcut: the whole file is fetched before it plays (the player cannot send the token), fine under the server's 64 MB cap.
		guard let local = await localCopy(of: file) else { return false }
		if file.isVideo {
			video.wrappedValue = VideoOpening(name: file.name, url: local)
		} else {
			preview.wrappedValue = local
		}
		return true
	}
}

extension View {
	/// Where a session's files open: the image gallery, the video player and
	/// Quick Look, shared by message mentions and the Files browser.
	func filePreviews(
		gallery: Binding<GalleryOpening?>, video: Binding<VideoOpening?>, preview: Binding<URL?>, viewModel: SessionDetailViewModel
	) -> some View {
		self
			#if os(iOS)
			.fullScreenCover(item: gallery) { opening in
				ImageGallery(images: opening.images, index: opening.index, viewModel: viewModel)
			}
			.fullScreenCover(item: video) { VideoSheet(opening: $0) }
			#else
			.sheet(item: gallery) { opening in
				ImageGallery(images: opening.images, index: opening.index, viewModel: viewModel)
					.frame(minWidth: 640, idealWidth: 900, minHeight: 480, idealHeight: 700)
			}
			.sheet(item: video) { VideoSheet(opening: $0).frame(minWidth: 640, idealWidth: 900, minHeight: 420, idealHeight: 560) }
			#endif
			.quickLookPreview(preview)
	}
}

struct VideoOpening: Identifiable {
	let id = UUID()
	let name: String
	let url: URL
}

/// A mentioned video, playing as soon as it opens.
struct VideoSheet: View {
	@Environment(\.dismiss) private var dismiss
	private let name: String
	@State private var player: AVPlayer

	init(opening: VideoOpening) {
		name = opening.name
		_player = State(initialValue: AVPlayer(url: opening.url))
	}

	var body: some View {
		NavigationStack {
			VideoPlayer(player: player)
				.ignoresSafeArea(edges: .bottom)
				.navigationTitle(name)
				.deckInlineNavigationTitle()
				.toolbar {
					ToolbarItem(placement: .confirmationAction) {
						Button("Done") { dismiss() }.keyboardShortcut(.cancelAction)
					}
				}
		}
		.onAppear { player.play() }
		.onDisappear { player.pause() }
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
			pages
			HStack(spacing: 8) {
				Button("Done") { dismiss() }
					.accessibilityLabel("Close")
					.keyboardShortcut(.cancelAction)
				#if os(macOS)
				// No page swipe on a Mac: arrows, from the keyboard too.
				if images.count > 1 {
					Button { index = max(index - 1, 0) } label: { Image(systemName: "chevron.left") }
						.keyboardShortcut(.leftArrow, modifiers: [])
						.disabled(index == 0)
						.accessibilityLabel("Previous image")
					Button { index = min(index + 1, images.count - 1) } label: { Image(systemName: "chevron.right") }
						.keyboardShortcut(.rightArrow, modifiers: [])
						.disabled(index == images.count - 1)
						.accessibilityLabel("Next image")
				}
				#endif
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
		#if os(iOS)
		.statusBarHidden()
		#endif
	}

	@ViewBuilder
	private var pages: some View {
		#if os(iOS)
		TabView(selection: $index) {
			ForEach(Array(images.enumerated()), id: \.element.id) { i, file in
				ZoomableImage(image: loaded[file.path])
					.tag(i)
					.task(id: file.path) { await load(file) }
			}
		}
		.tabViewStyle(.page(indexDisplayMode: images.count > 1 ? .automatic : .never))
		.ignoresSafeArea()
		#else
		ZoomableImage(image: loaded[current.path])
			.padding(.top, 44)
			.task(id: current.path) { await load(current) }
		#endif
	}

	private func load(_ file: FileInfo) async {
		guard loaded[file.path] == nil, let data = await viewModel.fileData(path: file.path) else { return }
		loaded[file.path] = PlatformImage(data: data)
	}
}

/// A thumbnail of an attachment the message carried, fetched through the
/// authenticated client (a plain AsyncImage can't send the token).
struct AttachmentImage: View {
	let image: TranscriptImage
	var viewModel: SessionDetailViewModel?

	@State private var platformImage: PlatformImage?
	@State private var failed = false

	var body: some View {
		Group {
			if let platformImage {
				Image(platformImage: platformImage)
					.resizable()
					.scaledToFill()
					.draggable(Image(platformImage: platformImage))
			} else if failed {
				Image(systemName: "photo")
					.foregroundStyle(.secondary)
			} else {
				ProgressView().controlSize(.small)
			}
		}
		.frame(width: 96, height: 96)
		.clipShape(RoundedRectangle(cornerRadius: DeckStyle.Radius.control))
		.task(id: image) {
			guard platformImage == nil else { return }
			if let data = await viewModel?.imageData(for: image), let loaded = PlatformImage(data: data) {
				platformImage = loaded
			} else {
				failed = true
			}
		}
	}
}
