import SwiftUI
import DeckKit
import DeckUI

/// The session's folder (the web Files tab): browse down by tapping folders and
/// back up by the breadcrumb, with dotfiles and generated folders behind a
/// toggle. A file opens as a mentioned one does: images in the gallery, video
/// in the player, anything else in Quick Look. Files that look like credentials
/// ask before they open.
struct FilesSheet: View {
	let sessionId: String
	let viewModel: SessionDetailViewModel

	@Environment(DeckStore.self) private var store
	@Environment(\.dismiss) private var dismiss

	@State private var path = ""
	@State private var listing: DirListing?
	@State private var errorMessage: String?
	@State private var showHidden = false
	@State private var fetching: String?
	@State private var secret: DirEntry?
	@State private var openFailed: String?
	@State private var gallery: GalleryOpening?
	@State private var video: VideoOpening?
	@State private var preview: URL?

	private var entries: [DirEntry] {
		(listing?.entries ?? []).filter { showHidden || !FileBrowser.isTucked($0) }
	}

	var body: some View {
		NavigationStack {
			Group {
				if let errorMessage {
					ContentUnavailableView {
						Label("Couldn't open the folder", systemImage: "exclamationmark.triangle")
					} description: {
						Text(errorMessage)
					} actions: {
						if !path.isEmpty { Button("Back to the Session Folder") { path = "" } }
					}
				} else if let listing {
					list(listing)
				} else {
					ProgressView()
				}
			}
			.navigationTitle("Files")
			.deckInlineNavigationTitle()
			.toolbar {
				ToolbarItem(placement: .cancellationAction) {
					Button("Done") { dismiss() }
				}
				ToolbarItem(placement: .primaryAction) {
					Toggle(isOn: $showHidden) {
						Label("Show hidden files", systemImage: showHidden ? "eye" : "eye.slash")
					}
					.toggleStyle(.button)
					.accessibilityIdentifier("filesShowHidden")
				}
			}
		}
		.task(id: path) { await load() }
		.filePreviews(gallery: $gallery, video: $video, preview: $preview, viewModel: viewModel)
		.confirmationDialog(
			"Show \(secret?.name ?? "this file")?",
			isPresented: Binding(get: { secret != nil }, set: { if !$0 { secret = nil } }),
			titleVisibility: .visible,
			presenting: secret
		) { entry in
			Button("Show Contents") { open(entry) }
		} message: { _ in
			Text("It may hold credentials.")
		}
		.alert(
			"Couldn't open \(openFailed ?? "the file")",
			isPresented: Binding(get: { openFailed != nil }, set: { if !$0 { openFailed = nil } })
		) {
			Button("OK", role: .cancel) {}
		} message: {
			Text("deck won't serve it, or it is too large.")
		}
	}

	private func list(_ listing: DirListing) -> some View {
		List {
			Section {
				ForEach(entries) { entry in
					Button {
						tap(entry, in: listing)
					} label: {
						row(entry)
					}
					.buttonStyle(.plain)
					.disabled(fetching != nil)
				}
				if entries.isEmpty {
					Text(listing.entries.isEmpty ? "Empty folder" : "Only hidden files").foregroundStyle(.secondary)
				}
			} header: {
				crumbs(listing)
			} footer: {
				if listing.truncated { Text("Only the first \(listing.entries.count) entries are listed.") }
			}
		}
		.deckInsetGroupedList()
		.refreshable { await load() }
	}

	private func crumbs(_ listing: DirListing) -> some View {
		ScrollView(.horizontal, showsIndicators: false) {
			HStack(spacing: 4) {
				let crumbs = FileBrowser.crumbs(root: listing.root, path: listing.path)
				ForEach(Array(crumbs.enumerated()), id: \.element) { i, crumb in
					if i > 0 { Image(systemName: "chevron.right").imageScale(.small).foregroundStyle(.tertiary) }
					Button(crumb.label) { path = crumb.path }
						.disabled(crumb.path == listing.path)
						.buttonStyle(.borderless)
				}
			}
			.textCase(nil)
		}
		.accessibilityIdentifier("filesBreadcrumbs")
	}

	private func row(_ entry: DirEntry) -> some View {
		HStack {
			Label(entry.name, systemImage: icon(entry))
				.lineLimit(1)
				.truncationMode(.middle)
			Spacer()
			if fetching == entry.name {
				ProgressView().controlSize(.small)
			} else if entry.dir {
				Image(systemName: "chevron.right").foregroundStyle(.tertiary)
			} else {
				Text(MessageFiles.formatBytes(entry.size)).font(.caption).foregroundStyle(.secondary)
			}
		}
		.contentShape(Rectangle())
		.accessibilityLabel(entry.dir ? "Folder \(entry.name)" : entry.name)
	}

	private func icon(_ entry: DirEntry) -> String {
		if entry.dir { return "folder" }
		if FileBrowser.isSecretName(entry.name) { return "key" }
		if MessageFiles.isImage(entry.name) { return "photo" }
		return "doc"
	}

	private func tap(_ entry: DirEntry, in listing: DirListing) {
		if entry.dir {
			path = listing.relPath(entry)
		} else if MessageFiles.isImage(entry.name) {
			let images = entries.filter { !$0.dir && MessageFiles.isImage($0.name) }
			gallery = GalleryOpening(images: images.map(listing.file), index: images.firstIndex(of: entry) ?? 0)
		} else if FileBrowser.isSecretName(entry.name) {
			secret = entry
		} else {
			open(entry)
		}
	}

	private func open(_ entry: DirEntry) {
		guard let listing else { return }
		fetching = entry.name
		Task {
			if await !viewModel.openFile(listing.file(entry), video: $video, preview: $preview) { openFailed = entry.name }
			fetching = nil
		}
	}

	private func load() async {
		guard let client = store.client else { return }
		do {
			listing = try await client.listDir(sessionId: sessionId, path: path)
			errorMessage = nil
		} catch {
			errorMessage = error.localizedDescription
		}
	}
}
