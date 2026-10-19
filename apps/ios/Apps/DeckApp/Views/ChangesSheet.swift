import SwiftUI
import DeckKit

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
						HStack(alignment: .firstTextBaseline, spacing: 8) {
							Text(statusLetter(file.status))
								.font(.caption.monospaced().weight(.bold))
								.foregroundStyle(statusColor(file.status))
								.frame(width: 14)
							VStack(alignment: .leading, spacing: 2) {
								Text(file.path)
									.font(.footnote.monospaced())
									.lineLimit(2)
									.truncationMode(.head)
								if let old = file.oldPath {
									Text("was \(old)")
										.font(.caption2.monospaced())
										.foregroundStyle(.secondary)
										.lineLimit(1)
										.truncationMode(.head)
								}
							}
							Spacer()
							if file.binary == true {
								Text("binary").font(.caption2).foregroundStyle(.secondary)
							} else {
								DiffCounts(additions: file.additions ?? 0, deletions: file.deletions ?? 0)
							}
						}
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

	private func statusLetter(_ status: String) -> String {
		switch status {
		case "added": return "A"
		case "deleted": return "D"
		case "renamed": return "R"
		default: return "M"
		}
	}

	private func statusColor(_ status: String) -> Color {
		switch status {
		case "added": return .green
		case "deleted": return .red
		case "renamed": return .purple
		default: return .orange
		}
	}
}

struct DiffCounts: View {
	let additions: Int
	let deletions: Int

	var body: some View {
		HStack(spacing: 6) {
			Text("+\(additions)").foregroundStyle(.green)
			Text("-\(deletions)").foregroundStyle(.red)
		}
		.font(.caption.monospaced())
	}
}

/// One file's patch, line by line, coloured the way the web diff is.
struct FilePatchView: View {
	let file: DiffFile
	let patch: DiffPatch.File?

	var body: some View {
		Group {
			if let patch, !patch.lines.isEmpty {
				ScrollView([.vertical, .horizontal]) {
					LazyVStack(alignment: .leading, spacing: 0) {
						ForEach(patch.lines) { line in
							Text(prefix(line.kind) + line.text)
								.font(.caption.monospaced())
								.foregroundStyle(foreground(line.kind))
								.frame(maxWidth: .infinity, alignment: .leading)
								.padding(.horizontal, 8)
								.padding(.vertical, 1)
								.background(background(line.kind))
						}
					}
					.textSelection(.enabled)
				}
			} else if file.binary == true {
				ContentUnavailableView("Binary file", systemImage: "doc", description: Text("No text diff to show."))
			} else {
				ContentUnavailableView("Patch not included", systemImage: "doc.text", description: Text("The patch was capped server-side; only the summary is available for this file."))
			}
		}
		.navigationTitle((file.path as NSString).lastPathComponent)
		.navigationBarTitleDisplayMode(.inline)
	}

	private func prefix(_ kind: DiffPatch.LineKind) -> String {
		switch kind {
		case .added: return "+"
		case .removed: return "-"
		case .context: return " "
		case .hunk, .meta: return ""
		}
	}

	private func foreground(_ kind: DiffPatch.LineKind) -> Color {
		switch kind {
		case .hunk: return .blue
		case .meta: return .secondary
		default: return .primary
		}
	}

	private func background(_ kind: DiffPatch.LineKind) -> Color {
		switch kind {
		case .added: return .green.opacity(0.15)
		case .removed: return .red.opacity(0.15)
		case .hunk: return .blue.opacity(0.08)
		default: return .clear
		}
	}
}
