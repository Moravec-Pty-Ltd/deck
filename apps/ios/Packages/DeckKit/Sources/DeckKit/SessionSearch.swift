import Foundation

/// Matching sessions by name. Most of the time you know which session you want
/// and you are trying to get to it, so names lead the search and what was said
/// follows. Mirrors deck's `matchSessionNames` in `src/lib/search-core.ts`; the
/// tests carry the same cases so the two cannot drift.
public enum SessionSearch {
	/// Queries shorter than this match too much to be useful. Matches deck's
	/// MIN_QUERY_CHARS.
	public static let minimumQueryLength = 2

	/// What was typed, ready to match: lowercased and trimmed, and split into
	/// words. Nil when it is too short to be worth matching.
	public struct Query: Sendable {
		public let needle: String
		public let words: [String]

		public init?(_ raw: String) {
			let needle = raw
				.trimmingCharacters(in: .whitespacesAndNewlines)
				.lowercased()
			guard needle.count >= SessionSearch.minimumQueryLength else { return nil }
			let words = needle.split(whereSeparator: \.isWhitespace).map(String.init)
			guard !words.isEmpty else { return nil }
			self.needle = needle
			self.words = words
		}
	}

	/// How well `title` matches: 0 for the exact title, 1 for one starting with
	/// what was typed, 2 for one holding all the words anywhere, nil for no
	/// match. Lower is better. `extra` is more text the words may be found in
	/// (a command's keywords) without counting as the title.
	public static func rank(_ title: String, against query: Query, extra: String = "") -> Int? {
		let lower = title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
		guard !lower.isEmpty else { return nil }
		if lower == query.needle { return 0 }
		if lower.hasPrefix(query.needle) { return 1 }
		let haystack = extra.isEmpty ? lower : lower + " " + extra.lowercased()
		return query.words.allSatisfy({ haystack.contains($0) }) ? 2 : nil
	}

	/// `rank` for a session: when the title lacks some word, the session still
	/// matches (rank 3) if each word is in the title, equals one of its issue or
	/// PR references whole (so "31" does not find "#315"), or is in an issue's
	/// title. Mirrors `matchesRefs` in `src/lib/search-core.ts`.
	public static func rank(_ session: SessionDigest, against query: Query) -> Int? {
		let title = session.title ?? ""
		if let rank = rank(title, against: query) { return rank }
		let lower = title.lowercased()
		let refs = Self.refs(session)
		let issueTitles = (session.issues ?? []).map { $0.title ?? "" }.joined(separator: " ").lowercased()
		let all = query.words.allSatisfy { lower.contains($0) || refs.contains($0) || issueTitles.contains($0) }
		return !lower.trimmingCharacters(in: .whitespaces).isEmpty && all ? 3 : nil
	}

	/// The references a session is found by, lowercased: each issue id and the
	/// PR as `repo#n`, plus their short forms (`repo#315`, `#315`, `315`).
	public static func refs(_ session: SessionDigest) -> Set<String> {
		var ids = (session.issues ?? []).map(\.issueId)
		if let repo = session.pr?.repo, let number = session.pr?.number { ids.append("\(repo)#\(number)") }
		var refs = Set<String>()
		for id in ids {
			let lower = id.lowercased()
			refs.insert(lower)
			guard let hash = lower.lastIndex(of: "#") else { continue }
			refs.insert(String(lower[hash...]))
			refs.insert(String(lower[lower.index(after: hash)...]))
			let slash = lower[..<hash].lastIndex(of: "/").map { lower.index(after: $0) } ?? lower.startIndex
			refs.insert(String(lower[slash...]))
		}
		refs.remove("")
		return refs
	}

	/// Every session whose title holds all the words typed, best first: an exact
	/// title, then one starting with what was typed, then the rest, then those
	/// found only by issue or PR reference. Stable
	/// within a rank, so the caller's order (recency) survives.
	///
	/// Word-wise rather than substring, so "auth token" finds "Auth: token
	/// refresh" and the order of what you type does not matter.
	public static func byName(_ query: String, in sessions: [SessionDigest]) -> [SessionDigest] {
		guard let query = Query(query) else { return [] }
		let ranked = sessions.enumerated().compactMap { index, session -> (Int, Int, SessionDigest)? in
			guard let rank = rank(session, against: query) else { return nil }
			return (rank, index, session)
		}
		// Sort on (rank, original position) so equal ranks keep their order.
		return ranked
			.sorted { $0.0 != $1.0 ? $0.0 < $1.0 : $0.1 < $1.1 }
			.map(\.2)
	}
}
