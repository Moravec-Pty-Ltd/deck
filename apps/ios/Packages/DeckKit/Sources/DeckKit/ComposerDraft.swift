import Foundation

/// The composer's saved draft. Mirrors deck's `composer-draft-core.ts`: one
/// draft, not keyed by session, that remembers where it was started so the
/// composer can warn before sending it somewhere else.
public struct ComposerDraft: Equatable, Sendable {
	public var text: String
	public var images: [DeckImage]
	public var originSessionId: String?

	public init(text: String = "", images: [DeckImage] = [], originSessionId: String? = nil) {
		self.text = text
		self.images = images
		self.originSessionId = originSessionId
	}

	public var isEmpty: Bool {
		text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && images.isEmpty
	}

	/// Summed base64 characters of the images worth keeping on disk. Text is
	/// always kept; images past this are dropped rather than failing the save.
	public static let attachmentBudget = 1_500_000

	/// Keeps images greedily and stops at the first that would overflow, so a
	/// small image behind a large one is dropped too.
	public static func clamped(_ images: [DeckImage], budget: Int = attachmentBudget) -> [DeckImage] {
		var used = 0
		var kept: [DeckImage] = []
		for image in images {
			if used + image.data.utf8.count > budget { break }
			kept.append(image)
			used += image.data.utf8.count
		}
		return kept
	}

	private struct Stored: Codable {
		struct Image: Codable {
			var mediaType: String
			var data: String
		}
		// Decodes to nil instead of throwing, so one malformed image is skipped.
		private struct Lenient: Decodable {
			var image: Image?
			init(from decoder: Decoder) throws { image = try? Image(from: decoder) }
		}

		var text: String
		var images: [Image]
		var originSessionId: String?

		init(text: String, images: [Image], originSessionId: String?) {
			self.text = text
			self.images = images
			self.originSessionId = originSessionId
		}

		init(from decoder: Decoder) throws {
			let c = try decoder.container(keyedBy: Keys.self)
			text = (try? c.decode(String.self, forKey: .text)) ?? ""
			originSessionId = try? c.decode(String.self, forKey: .originSessionId)
			images = ((try? c.decode([Lenient].self, forKey: .images)) ?? []).compactMap(\.image)
		}

		private enum Keys: String, CodingKey { case text, images, originSessionId }
	}

	private init(_ stored: Stored) {
		self.init(
			text: stored.text,
			images: stored.images.map { DeckImage(mediaType: $0.mediaType, data: $0.data) },
			originSessionId: stored.originSessionId
		)
	}

	private func stored(budget: Int) -> Stored {
		Stored(
			text: text,
			images: Self.clamped(images, budget: budget).map { .init(mediaType: $0.mediaType, data: $0.data) },
			originSessionId: originSessionId
		)
	}

	/// JSON for disk, or nil when there is nothing worth keeping.
	public func encoded(budget: Int = Self.attachmentBudget) -> Data? {
		guard !isEmpty else { return nil }
		return try? JSONEncoder().encode(stored(budget: budget))
	}

	/// Nil for missing, malformed or empty data. Images get fresh ids.
	public static func decoded(_ data: Data?) -> ComposerDraft? {
		guard let data, let stored = try? JSONDecoder().decode(Stored.self, from: data) else { return nil }
		let draft = ComposerDraft(stored)
		return draft.isEmpty ? nil : draft
	}

	/// The origin after an edit: held until the draft empties, and the current
	/// session is adopted only when the draft first becomes non-empty.
	public static func nextOrigin(_ previous: String?, isEmpty: Bool, current: String) -> String? {
		isEmpty ? nil : (previous ?? current)
	}

	public static func isCrossSession(_ origin: String?, current: String) -> Bool {
		origin != nil && origin != current
	}
}
