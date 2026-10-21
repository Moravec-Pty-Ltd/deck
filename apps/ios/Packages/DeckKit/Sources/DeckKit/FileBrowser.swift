import Foundation

// The session Files browser, the same reading as deck's web Files tab
// (file-browser-core.ts): which entries are tucked behind "show hidden" and
// which look like credentials. deck decides what is listed and served.

/// One entry of `GET /api/agent/sessions/<id>/dir`.
public struct DirEntry: Codable, Hashable, Identifiable, Sendable {
	public var id: String { name }
	public let name: String
	public let dir: Bool
	public let size: Int
	public let mtimeMs: Double

	public init(name: String, dir: Bool, size: Int = 0, mtimeMs: Double = 0) {
		self.name = name
		self.dir = dir
		self.size = size
		self.mtimeMs = mtimeMs
	}
}

/// A folder under the session's folder, folders first in natural order.
public struct DirListing: Codable, Equatable, Sendable {
	/// Relative to the session's folder, "" for the folder itself.
	public let path: String
	/// The session's folder, absolute and canonical.
	public let root: String
	public let entries: [DirEntry]
	/// More entries than deck lists; the rest were left out.
	public let truncated: Bool

	public func relPath(_ entry: DirEntry) -> String {
		path.isEmpty ? entry.name : "\(path)/\(entry.name)"
	}

	/// An entry as the files route serves it, by absolute path, so the
	/// mention previews (gallery, player, Quick Look) open it unchanged.
	public func file(_ entry: DirEntry) -> FileInfo {
		let ext = (entry.name as NSString).pathExtension.lowercased()
		return FileInfo(
			path: "\(root)/\(relPath(entry))", name: entry.name, size: entry.size,
			mime: FileBrowser.videoExtensions.contains(ext) ? "video/\(ext)" : "",
			image: MessageFiles.isImage(entry.name))
	}
}

public enum FileBrowser {
	static let videoExtensions: Set<String> = ["mp4", "webm", "mov", "m4v"]

	private static let noiseDirs: Set<String> = ["node_modules", "__pycache__", ".venv", "venv", "dist", "build", "target", "coverage"]

	/// Dotfiles and generated folders: listed only when "show hidden" is on.
	public static func isTucked(_ entry: DirEntry) -> Bool {
		entry.name.hasPrefix(".") || (entry.dir && noiseDirs.contains(entry.name))
	}

	private static func matches(_ name: String, _ pattern: String) -> Bool {
		name.range(of: pattern, options: .regularExpression) != nil
	}

	/// Files whose contents are likely credentials, kept covered until asked.
	/// Templates like `.env.example` are left alone.
	public static func isSecretName(_ name: String) -> Bool {
		let n = name.lowercased()
		if matches(n, #"\.(example|sample|template|dist)$"#) { return false }
		if n == ".env" || n.hasPrefix(".env.") || n.hasSuffix(".env") { return true }
		if matches(n, #"\.(pem|key|p12|pfx|keystore|jks)$"#) { return true }
		if matches(n, #"^id_(rsa|dsa|ecdsa|ed25519)$"#) { return true }
		return matches(n, #"^(credentials|secrets?)(\..+)?$"#) || [".netrc", ".npmrc", ".pypirc"].contains(n)
	}

	public struct Crumb: Hashable, Sendable {
		public let label: String
		public let path: String
	}

	/// The session folder's own name, then each folder down to `path`.
	public static func crumbs(root: String, path: String) -> [Crumb] {
		let rootName = (root as NSString).lastPathComponent
		var out = [Crumb(label: rootName.isEmpty ? "/" : rootName, path: "")]
		var acc = ""
		for seg in path.split(separator: "/") {
			acc = acc.isEmpty ? String(seg) : "\(acc)/\(seg)"
			out.append(Crumb(label: String(seg), path: acc))
		}
		return out
	}
}

extension DeckClient {
	/// One folder of the session's Files browser, `path` relative to its folder.
	public func listDir(sessionId: String, path: String) async throws -> DirListing {
		try await get("/api/agent/sessions/\(sessionId)/dir", query: [URLQueryItem(name: "path", value: path)])
	}
}
