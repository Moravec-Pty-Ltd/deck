import Foundation

// Local files a message mentions, the same reading of a message as deck's
// web client (files-core.ts): which paths it names and which of those are
// images. deck decides what is actually served.

/// A file deck can serve for a mention, as `POST /api/sessions/<id>/files`
/// describes it.
public struct FileInfo: Codable, Hashable, Identifiable, Sendable {
	public var id: String { path }
	/// The mention as it appeared in the text.
	public let path: String
	public let name: String
	public let size: Int
	public let mime: String
	public let image: Bool

	public init(path: String, name: String, size: Int, mime: String, image: Bool) {
		self.path = path
		self.name = name
		self.size = size
		self.mime = mime
		self.image = image
	}
}

public enum MessageFiles {
	public static let maxPathsPerMessage = 20

	// Absolute, home, file URL and explicit relative (`./`, `../`) paths with
	// an extension; bare references like `src/lib/foo.ts` are left alone. A
	// path stops at whitespace, quotes, brackets and sentence punctuation.
	private static let pattern = try! NSRegularExpression(
		pattern: #"(?<![\w/:.@~-])(?:file://)?((?:~|\.{1,2})?/(?:[^\s"'`<>|*?()\[\]{},;:]+/)*[^\s"'`<>|*?()\[\]{},;:/]+\.[A-Za-z0-9]{1,8})(?![\w/-]|\.[\w/])"#)

	public static func paths(in text: String) -> [String] {
		var found: [String] = []
		let range = NSRange(text.startIndex..., in: text)
		for match in pattern.matches(in: text, range: range) {
			guard let r = Range(match.range(at: 1), in: text) else { continue }
			let path = String(text[r])
			if !found.contains(path) { found.append(path) }
			if found.count >= maxPathsPerMessage { break }
		}
		return found
	}

	private static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg", "heic", "heif"]

	public static func isImage(_ path: String) -> Bool {
		imageExtensions.contains((path as NSString).pathExtension.lowercased())
	}

	public static func formatBytes(_ size: Int) -> String {
		if size < 1024 { return "\(size) B" }
		if size < 1024 * 1024 { return String(format: size < 10 * 1024 ? "%.1f KB" : "%.0f KB", Double(size) / 1024) }
		return String(format: "%.1f MB", Double(size) / (1024 * 1024))
	}
}

extension DeckClient {
	/// Which of a message's mentions deck can serve.
	public func statFiles(sessionId: String, paths: [String]) async throws -> [FileInfo] {
		struct Reply: Decodable { let files: [FileInfo] }
		let reply: Reply = try await post("/api/sessions/\(sessionId)/files", json: ["paths": Array(paths.prefix(MessageFiles.maxPathsPerMessage))])
		return reply.files
	}

	/// The bytes of a mentioned file.
	public func fileData(sessionId: String, path: String) async throws -> Data {
		try await getData("/api/sessions/\(sessionId)/files", query: [URLQueryItem(name: "path", value: path)])
	}
}
