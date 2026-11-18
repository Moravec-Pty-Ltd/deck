import SwiftUI
import DeckKit

/// One changed file in a diff summary: its status letter, path (and the path
/// it was renamed from), and its line counts.
public struct DiffFileRow: View {
	let file: DiffFile

	public init(file: DiffFile) {
		self.file = file
	}

	public var body: some View {
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

public struct DiffCounts: View {
	let additions: Int
	let deletions: Int

	public init(additions: Int, deletions: Int) {
		self.additions = additions
		self.deletions = deletions
	}

	public var body: some View {
		HStack(spacing: 6) {
			Text("+\(additions)").foregroundStyle(.green)
			Text("-\(deletions)").foregroundStyle(.red)
		}
		.font(.caption.monospaced())
	}
}

/// One file's patch, line by line, coloured the way the web diff is.
public struct FilePatchView: View {
	let file: DiffFile
	let patch: DiffPatch.File?
	@State private var viewportWidth: CGFloat = 0
	@State private var longestWidth: CGFloat = 0

	public init(file: DiffFile, patch: DiffPatch.File?) {
		self.file = file
		self.patch = patch
	}

	public var body: some View {
		Group {
			if let patch, !patch.lines.isEmpty {
				// A two-axis scroll view offers no width, so rows are sized explicitly:
				// every row is as wide as the viewport or the longest line, whichever is wider.
				ScrollView([.vertical, .horizontal]) {
					LazyVStack(alignment: .leading, spacing: 0) {
						ForEach(patch.lines) { line in
							row(prefix(line.kind) + line.text, line.kind)
								.frame(minWidth: max(viewportWidth, longestWidth), alignment: .leading)
								.background(background(line.kind))
						}
					}
					.textSelection(.enabled)
					.background(alignment: .topLeading) {
						// shortcut: longest by character count, so wide glyphs (CJK, emoji) can measure short; measure every line if that shows up.
						if let longest = patch.lines.map(measured).max(by: { $0.count < $1.count }) {
							row(longest, .context)
								.hidden()
								.onGeometryChange(for: CGFloat.self) { $0.size.width } action: { longestWidth = $0 }
						}
					}
				}
				// Rows widen after the first layout, which otherwise leaves the view scrolled to the middle.
				.defaultScrollAnchor(.topLeading)
				.onScrollGeometryChange(for: CGFloat.self) { $0.containerSize.width - $0.contentInsets.leading - $0.contentInsets.trailing } action: { _, width in viewportWidth = width }
			} else if file.binary == true {
				ContentUnavailableView("Binary file", systemImage: "doc", description: Text("No text diff to show."))
			} else {
				ContentUnavailableView("Patch not included", systemImage: "doc.text", description: Text("The patch was capped server-side; only the summary is available for this file."))
			}
		}
		.navigationTitle((file.path as NSString).lastPathComponent)
		.deckInlineNavigationTitle()
	}

	private func row(_ text: String, _ kind: DiffPatch.LineKind) -> some View {
		Text(text)
			.font(.caption.monospaced())
			.foregroundStyle(foreground(kind))
			.fixedSize(horizontal: true, vertical: false)
			.padding(.horizontal, 8)
			.padding(.vertical, 1)
	}

	// A tab draws at most about 4.5 characters wide, so 5 spaces never measures short.
	private func measured(_ line: DiffPatch.Line) -> String {
		prefix(line.kind) + line.text.replacingOccurrences(of: "\t", with: "     ")
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
