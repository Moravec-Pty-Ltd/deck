import SwiftUI
import DeckKit
import DeckUI

/// The session's diff against its base branch (the web Changes tab): a per-file
/// summary, and each file's patch behind a tap.
struct ChangesSheet: View {
	let sessionId: String
	let title: String

	@Environment(DeckStore.self) private var store
	@Environment(\.dismiss) private var dismiss

	@State private var diff: WorktreeDiff?
	@State private var patch = DiffPatch(files: [])
	@State private var isLoading = false
	@State private var errorMessage: String?

	var body: some View {
		NavigationStack {
			Group {
				if isLoading && diff == nil {
					ProgressView("Comparing…")
				} else if let errorMessage {
					ContentUnavailableView("Couldn't load changes", systemImage: "exclamationmark.triangle", description: Text(errorMessage))
				} else if let diff, !diff.git {
					ContentUnavailableView("Not a git repository", systemImage: "folder", description: Text("The session directory has no git history to compare."))
				} else if let files = diff?.meta?.files, !files.isEmpty {
					fileList(files)
				} else if diff != nil {
					ContentUnavailableView("No changes", systemImage: "checkmark.circle", description: Text("The worktree matches \(diff?.meta?.baseRef ?? "its base")."))
				}
			}
			.navigationTitle("Changes")
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ToolbarItem(placement: .cancellationAction) {
					Button("Done") { dismiss() }
				}
				ToolbarItem(placement: .primaryAction) {
					Button {
						Task { await load() }
					} label: {
						Image(systemName: "arrow.clockwise")
					}
					.disabled(isLoading)
				}
			}
			.navigationDestination(for: DiffFile.self) { file in
				FilePatchView(file: file, patch: patch.file(at: file.path))
			}
			.task { await load() }
		}
	}

	private func fileList(_ files: [DiffFile]) -> some View {
		List {
			if let meta = diff?.meta {
				Section {
					HStack {
						Text("Against \(meta.baseRef ?? "base")")
						if meta.baseResolved == false {
							Text("(unresolved, using HEAD)").foregroundStyle(.secondary)
						}
						Spacer()
						DiffCounts(additions: meta.additions ?? 0, deletions: meta.deletions ?? 0)
					}
					.font(.footnote)
					if meta.truncated == true {
						Text("Large patch: some files show a summary only.")
							.font(.caption)
							.foregroundStyle(.secondary)
					}
				}
			}
			Section("\(files.count) files") {
				ForEach(files) { file in
					NavigationLink(value: file) {
						DiffFileRow(file: file)
					}
				}
			}
		}
		.listStyle(.insetGrouped)
	}

	private func load() async {
		guard let client = store.client else { return }
		isLoading = true
		errorMessage = nil
		do {
			let fresh = try await client.diff(sessionId: sessionId)
			diff = fresh
			patch = DiffPatch.parse(fresh.patch ?? "")
		} catch {
			errorMessage = error.localizedDescription
		}
		isLoading = false
	}
}
