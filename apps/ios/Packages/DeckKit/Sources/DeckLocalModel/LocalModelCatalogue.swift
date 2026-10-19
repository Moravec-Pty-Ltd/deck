import Foundation

// The models deck offers to run on the device, and what a hand-typed one has to
// look like (deck#239).
//
// No MLX import here on purpose: this is metadata and a validator, so it tests
// on its own and the Settings screen can draw the list without loading anything.

/// One model deck offers to download. `id` is its Hugging Face repo, which is
/// also the only thing MLX needs to fetch and load it.
public struct LocalModelOption: Identifiable, Hashable, Sendable {
	public let id: String
	/// What it is called on screen.
	public let name: String
	/// The weights as downloaded. Shown before committing to the download, and
	/// a rough guide to what it will want in memory while running.
	public let weightsBytes: Int64
	/// One line on when to pick this one over its neighbours.
	public let note: String

	public init(id: String, name: String, weightsBytes: Int64, note: String) {
		self.id = id
		self.name = name
		self.weightsBytes = weightsBytes
		self.note = note
	}

	/// "1.7 GB", for a list that is mostly about whether this fits.
	public var size: String {
		let gb = Double(weightsBytes) / 1_000_000_000
		return gb < 1 ? String(format: "%.0f MB", gb * 1000) : String(format: "%.1f GB", gb)
	}
}

public enum LocalModelCatalogue {
	/// The shortlist, smallest first. Deliberately short: this is a starting
	/// point, not a catalogue of everything that exists. Anything else is typed
	/// in as a repo id, which is the same thing the entries below are.
	///
	/// All four call tools and have a context window in the tens of thousands,
	/// against the 4,096 tokens of Apple's own model, which is the whole reason
	/// for running one of these instead.
	///
	/// Sizes are the weights as published, read from the Hugging Face API on
	/// 2026-10-13 rather than estimated.
	public static let suggested: [LocalModelOption] = [
		LocalModelOption(
			id: "mlx-community/Qwen3-1.7B-4bit",
			name: "Qwen3 1.7B",
			weightsBytes: 970_000_000,
			note: "The lightest one worth asking to call a tool. Pick it if 2B is too much for your phone."),
		LocalModelOption(
			id: "mlx-community/Qwen3.5-2B-4bit",
			name: "Qwen3.5 2B",
			weightsBytes: 1_720_000_000,
			note: "Suggested. The same family as the model on the deck machine, two sizes down, so it behaves the way that one does."),
		LocalModelOption(
			id: "mlx-community/Llama-3.2-3B-Instruct-4bit",
			name: "Llama 3.2 3B",
			weightsBytes: 1_810_000_000,
			note: "A second opinion in another family, if Qwen misreads what you ask for."),
		LocalModelOption(
			id: "mlx-community/Qwen3-4B-4bit",
			name: "Qwen3 4B",
			weightsBytes: 2_260_000_000,
			note: "The most capable of these. Worth it on a phone with the memory to spare.")
	]

	/// What a fresh install runs, if the user downloads without choosing.
	///
	/// Qwen, because the deck machine's operator already runs Qwen3.5 and its
	/// one quirk is known: thinking has to stay on for a tool turn or it
	/// narrates what it would do instead of doing it. 2B is the smallest size of
	/// that generation, which keeps the download to something a phone will
	/// actually finish.
	public static let suggestedId = "mlx-community/Qwen3.5-2B-4bit"

	public static var suggestedOption: LocalModelOption? {
		option(for: suggestedId)
	}

	public static func option(for id: String) -> LocalModelOption? {
		suggested.first { $0.id == id }
	}

	/// What to call a model deck has no entry for: the repo's own name, without
	/// the owner, which is what distinguishes one from another in a list.
	public static func displayName(for id: String) -> String {
		option(for: id)?.name ?? id.split(separator: "/").last.map(String.init) ?? id
	}

	// A Hugging Face repo is `owner/name`. Both halves allow ASCII letters,
	// digits and `._-`; anything else is a typo, or an attempt to reach
	// somewhere else on disk, since this string becomes a path under the model
	// cache. Spelled out rather than as a regex: a character check says what it
	// means, and the leading-character rule is part of the rule, not a detail.
	private static func isUsableSegment(_ part: Substring) -> Bool {
		func allowed(_ c: Character) -> Bool {
			c.isASCII && (c.isLetter || c.isNumber || c == "." || c == "-" || c == "_")
		}
		guard let first = part.first, first.isASCII, first.isLetter || first.isNumber else { return false }
		return part.allSatisfy(allowed)
	}

	/// Why a typed repo id cannot be used, or nil if it can.
	///
	/// Shape only. Whether the repo exists, and whether its weights are in MLX
	/// format rather than GGUF, is something only the download can answer, and
	/// it says so when it fails.
	public static func repoProblem(_ raw: String) -> String? {
		let id = raw.trimmingCharacters(in: .whitespacesAndNewlines)
		if id.isEmpty { return "Enter a Hugging Face repo, like mlx-community/Qwen3.5-2B-4bit." }
		let parts = id.split(separator: "/", omittingEmptySubsequences: false)
		guard parts.count == 2 else {
			return "That needs to be owner/name, like mlx-community/Qwen3.5-2B-4bit."
		}
		guard parts.allSatisfy(isUsableSegment) else {
			return "Only letters, digits, dots, dashes and underscores, either side of the slash."
		}
		return nil
	}

	/// The typed id as it should be stored: trimmed, and nothing else. Case is
	/// left alone because Hugging Face repo names are case-sensitive.
	public static func normalise(_ raw: String) -> String {
		raw.trimmingCharacters(in: .whitespacesAndNewlines)
	}
}
