import Foundation

/// The app's one saved composer draft, shared by every composer on screen.
/// Whichever session started typing owns the slot, so a second visible
/// composer can't overwrite it; the slot is handed on when the owner leaves.
@MainActor
public final class DraftStore {
	public static let shared: DraftStore = {
		let dir = try? FileManager.default.url(
			for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
		return DraftStore(fileURL: dir?.appendingPathComponent("composer-draft.json"))
	}()

	public private(set) var saved: ComposerDraft?

	private var owner: String?
	/// Who left the saved draft there. Their composer can come back (a push
	/// over the inbox, the same session reopened) and keep writing it.
	private var releasedBy: String?
	private let fileURL: URL?
	private var pending: Task<Void, Never>?

	public init(fileURL: URL?) {
		self.fileURL = fileURL
		saved = fileURL.flatMap { try? Data(contentsOf: $0) }.flatMap(ComposerDraft.decoded)
	}

	/// A composer appearing with an empty draft asks for the saved one. Only an
	/// unowned slot, or one this session already owns, is handed over.
	public func claim(for sessionId: String) -> ComposerDraft? {
		guard owner == nil || owner == sessionId, let saved else { return nil }
		owner = sessionId
		releasedBy = nil
		return saved
	}

	/// Called on every edit. Only the owner, the first typist into an empty
	/// unowned slot, or the session that left the saved draft writes through;
	/// other composers keep their draft in memory.
	public func update(_ draft: ComposerDraft, from sessionId: String) {
		guard owner == sessionId || (owner == nil && (saved == nil || releasedBy == sessionId)) else { return }
		releasedBy = nil
		if draft.isEmpty {
			saved = nil
			owner = nil
		} else {
			saved = draft
			owner = sessionId
		}
		scheduleSave()
	}

	/// The composer is leaving the screen. A non-empty draft becomes the saved
	/// one, unowned; an empty one only releases the slot if it held it.
	public func release(_ draft: ComposerDraft, from sessionId: String) {
		if !draft.isEmpty {
			saved = draft
			owner = nil
			releasedBy = sessionId
		} else if owner == sessionId {
			owner = nil
		}
		flush()
	}

	public func flush() {
		pending?.cancel()
		pending = nil
		guard let fileURL else { return }
		if let data = saved?.encoded() {
			try? data.write(to: fileURL, options: .atomic)
		} else {
			try? FileManager.default.removeItem(at: fileURL)
		}
	}

	private func scheduleSave() {
		pending?.cancel()
		pending = Task { [weak self] in
			try? await Task.sleep(for: .milliseconds(300))
			guard !Task.isCancelled else { return }
			self?.flush()
		}
	}
}
