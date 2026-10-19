import Foundation

/// A unified diff split per file and hunk, for the Changes screen. Parses the
/// `git diff` patch the session diff endpoint returns; the per-file summary
/// (status, counts) rides alongside in the response's `meta`, so this only
/// needs the lines.
public struct DiffPatch: Equatable, Sendable {
	public enum LineKind: Sendable {
		case context, added, removed, hunk, meta
	}

	public struct Line: Equatable, Identifiable, Sendable {
		public let id: Int
		public let kind: LineKind
		public let text: String
	}

	public struct File: Equatable, Identifiable, Sendable {
		public var id: String { path }
		public let path: String
		public let oldPath: String?
		public let lines: [Line]
	}

	public let files: [File]

	public init(files: [File]) {
		self.files = files
	}

	/// The patch for one path, or nil when the file's diff was trimmed away
	/// (a large patch is capped server-side).
	public func file(at path: String) -> File? {
		files.first { $0.path == path }
	}

	public static func parse(_ patch: String) -> DiffPatch {
		var files: [File] = []
		var path: String?
		var oldPath: String?
		var lines: [Line] = []
		var counter = 0
		func flush() {
			if let path { files.append(File(path: path, oldPath: oldPath, lines: lines)) }
			path = nil
			oldPath = nil
			lines = []
		}
		func line(_ kind: LineKind, _ text: String) {
			counter += 1
			lines.append(Line(id: counter, kind: kind, text: text))
		}
		for raw in patch.split(separator: "\n", omittingEmptySubsequences: false) {
			let text = String(raw)
			if text.hasPrefix("diff --git ") {
				flush()
				let names = DiffPatch.gitPaths(text)
				path = names.new
				oldPath = names.old == names.new ? nil : names.old
				continue
			}
			guard path != nil else { continue }
			if text.hasPrefix("@@") {
				line(.hunk, text)
			} else if text.hasPrefix("+++ ") || text.hasPrefix("--- ") || text.hasPrefix("index ")
				|| text.hasPrefix("new file") || text.hasPrefix("deleted file") || text.hasPrefix("similarity")
				|| text.hasPrefix("rename ") || text.hasPrefix("old mode") || text.hasPrefix("new mode")
				|| text.hasPrefix("Binary files") {
				line(.meta, text)
			} else if text.hasPrefix("+") {
				line(.added, String(text.dropFirst()))
			} else if text.hasPrefix("-") {
				line(.removed, String(text.dropFirst()))
			} else if text.hasPrefix("\\") {
				line(.meta, text)
			} else if text.isEmpty {
				continue
			} else {
				line(.context, String(text.dropFirst()))
			}
		}
		flush()
		return DiffPatch(files: files)
	}

	/// `diff --git a/old b/new` → (old, new). Paths with spaces stay whole as
	/// long as the two halves mirror each other, which git guarantees.
	static func gitPaths(_ header: String) -> (old: String, new: String) {
		let rest = header.dropFirst("diff --git ".count)
		if let range = rest.range(of: " b/") {
			let old = String(rest[rest.startIndex..<range.lowerBound]).replacingOccurrences(of: "a/", with: "", options: .anchored)
			let new = String(rest[range.upperBound...])
			return (old, new)
		}
		return (String(rest), String(rest))
	}
}
