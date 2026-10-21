import Foundation

/// Turning what someone said into what deck needs. Ported from deck's
/// `src/lib/operator-core.ts`, which used to do this server-side; it moved here
/// with the operator's brain. The tests mirror that module's cases, because two
/// copies of the same rules drift the moment nothing compares them.
public enum OperatorPhrasing {
	private static let ordinals = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]
	private static let positions = [
		"first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth",
	]

	/// A spoken answer to a multiple-choice question: the option whose label was
	/// said, or the one its number points at ("two", "option 2", "the second
	/// one"). nil when the words match nothing, so the caller sends them as
	/// free text.
	public static func pickOption(_ answer: String, options: [String]) -> String? {
		let said = answer.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
		if let exact = options.first(where: { $0.lowercased() == said }) { return exact }

		let contained = options.filter { said.contains($0.lowercased()) }
		if contained.count == 1 { return contained[0] }

		let index: Int
		if let digit = firstStandaloneDigit(in: said) {
			index = digit - 1
		} else if let ordinal = ordinals.firstIndex(where: { containsWord($0, in: said) }) {
			index = ordinal
		} else if let position = positions.firstIndex(where: { said.contains($0) }) {
			index = position
		} else {
			return nil
		}
		return index >= 0 && index < options.count ? options[index] : nil
	}

	/// Sessions a spoken reference could mean: an exact id, else every session
	/// whose title contains all the words said.
	public static func matchSessions(_ reference: String, in sessions: [SessionDigest]) -> [SessionDigest] {
		if let exact = sessions.first(where: { $0.id == reference }) { return [exact] }
		let words = reference.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
		guard !words.isEmpty else { return [] }
		return sessions.filter { session in
			let title = (session.title ?? "").lowercased()
			return words.allSatisfy { title.contains($0) }
		}
	}

	/// A single digit standing on its own, so "option 2" matches but "SKO-136"
	/// does not hand back its 1.
	private static func firstStandaloneDigit(in text: String) -> Int? {
		let scalars = Array(text)
		for (i, character) in scalars.enumerated() where character.isNumber {
			let beforeOK = i == 0 || !(scalars[i - 1].isNumber || scalars[i - 1].isLetter)
			let afterOK = i == scalars.count - 1 || !(scalars[i + 1].isNumber || scalars[i + 1].isLetter)
			if beforeOK, afterOK, let value = character.wholeNumberValue { return value }
		}
		return nil
	}

	private static func containsWord(_ word: String, in text: String) -> Bool {
		text.range(of: "\\b\(word)\\b", options: [.regularExpression]) != nil
	}
}
