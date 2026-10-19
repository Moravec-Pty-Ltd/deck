import Foundation

/// Matching sessions by name. Most of the time you know which session you want
/// and you are trying to get to it, so names lead the search and what was said
/// follows. Mirrors deck's `matchSessionNames` in `src/lib/search-core.ts`; the
/// tests carry the same cases so the two cannot drift.
public enum SessionSearch {
	/// Queries shorter than this match too much to be useful. Matches deck's
	/// MIN_QUERY_CHARS.
	public static let minimumQueryLength = 2

	/// Every session whose title holds all the words typed, best first: an exact
	/// title, then one starting with what was typed, then the rest. Stable
	/// within a rank, so the caller's order (recency) survives.
	///
	/// Word-wise rather than substring, so "auth token" finds "Auth: token
	/// refresh" and the order of what you type does not matter.
	public static func byName(_ query: String, in sessions: [SessionDigest]) -> [SessionDigest] {
		let needle = query
			.trimmingCharacters(in: .whitespacesAndNewlines)
			.lowercased()
		guard needle.count >= minimumQueryLength else { return [] }
		let words = needle.split(whereSeparator: \.isWhitespace).map(String.init)
		guard !words.isEmpty else { return [] }

		let ranked = sessions.enumerated().compactMap { index, session -> (Int, Int, SessionDigest)? in
			let title = (session.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
			guard !title.isEmpty else { return nil }
			let lower = title.lowercased()
			guard words.allSatisfy({ lower.contains($0) }) else { return nil }
			let rank = lower == needle ? 0 : lower.hasPrefix(needle) ? 1 : 2
			return (rank, index, session)
		}
		// Sort on (rank, original position) so equal ranks keep their order.
		return ranked
			.sorted { $0.0 != $1.0 ? $0.0 < $1.0 : $0.1 < $1.1 }
			.map(\.2)
	}
}
