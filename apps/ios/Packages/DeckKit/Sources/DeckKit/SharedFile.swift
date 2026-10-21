import Foundation
#if canImport(UniformTypeIdentifiers)
import UniformTypeIdentifiers
#endif

/// A file handed to deck from outside it — the iOS share sheet, mostly.
///
/// Images are deliberately not special here. A picture shared as a *file* is
/// something the agent reads from disk like any other; a picture the model
/// should look at goes through the send endpoint's `images` instead, which is
/// the app's own attach flow.
public struct SharedFile: Identifiable, Hashable, Sendable {
	public let id = UUID()
	public let name: String
	public let data: Data

	public init(name: String, data: Data) {
		self.name = name
		self.data = data
	}

	public var byteCount: Int { data.count }
}

/// What the share sheet hands over, and what deck will take.
public enum ShareLimits {
	/// Matches deck's own cap (see `$lib/upload-core.ts`), so the extension can
	/// say no before spending a request on something the server will refuse.
	public static let maxBytes = 25 * 1024 * 1024
	public static let maxFiles = 10

	/// Why this file can't be shared, or nil when it can.
	public static func rejection(for file: SharedFile) -> String? {
		guard file.byteCount > maxBytes else { return nil }
		let mb = Double(file.byteCount) / (1024 * 1024)
		return String(format: "%@ is %.1f MB; the limit is %d MB", file.name, mb, maxBytes / (1024 * 1024))
	}
}

/// The sessions a share sheet offers, newest activity first and capped. The cap
/// is the point: a share sheet is a two-second decision, and a list of seventy
/// sessions is not one. What you want is almost always what you touched last.
public enum ShareTargets {
	public static let listLimit = 20

	public static func pick(_ sessions: [SessionDigest], limit: Int = listLimit) -> [SessionDigest] {
		sessions
			.filter { $0.hidden != true }
			.sorted { ($0.lastActiveAt ?? 0) > ($1.lastActiveAt ?? 0) }
			.prefix(limit)
			.map { $0 }
	}
}
