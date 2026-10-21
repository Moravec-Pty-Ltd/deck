import Foundation
import Observation
import DeckKit

/// Drives a single session's detail screen: the live transcript stream (only
/// while the view is visible), older history on demand, plus the actions
/// available there. Wraps `DeckStore` for the shared session/ask state and
/// `DeckStore.client` for calls DeckStore itself doesn't expose (transcript,
/// review, merge, images).
@MainActor
@Observable
final class SessionDetailViewModel {
	let sessionId: String
	private let store: DeckStore

	var items: [TranscriptItem] = []
	/// A subagent's items, by the Agent call that launched it; kept out of `items`.
	var steps: [String: [TranscriptItem]] = [:]
	/// The session's subagents (status, activity, reports), from the server.
	private(set) var agents = SubagentsState()
	private var agentsFetch: Task<Void, Never>?
	private var agentsStale = false
	var streamingText = ""
	var isLoadingTranscript = false
	var didLoadOnce = false
	var errorMessage: String?
	/// Whether the reader is at (or near) the newest output. Set by the view from
	/// its scroll geometry; live output only pulls the view down while it is true,
	/// so scrolling up to read stays put.
	var isNearBottom = true
	/// Absolute index of the first loaded event. Above zero means older history
	/// remains on the server.
	private(set) var baseIndex = 0
	private(set) var isLoadingOlder = false

	var hasOlderHistory: Bool { didLoadOnce && baseIndex > 0 && store.supports(.history) }

	/// Voice mode for this session: reads what the live stream delivers and
	/// sends what you say through the same store calls the composer uses.
	private(set) var voice: VoiceController?

	private var streamTask: Task<Void, Never>?
	private var builder = TranscriptBuilder()
	private var imageCache: [String: Data] = [:]
	// Local files the transcript mentions: which deck can serve, and their bytes.
	private var fileInfo: [String: FileInfo] = [:]
	private var filesAsked = Set<String>()
	private var fileCache: [String: Data] = [:]

	/// How much older history one back-scroll pulls, matching the web view.
	private static let historyChunk = 250

	init(sessionId: String, store: DeckStore) {
		self.sessionId = sessionId
		self.store = store
	}

	var session: SessionDigest? {
		store.sessions.first { $0.id == sessionId }
	}

	/// The voice controller, made on first use so screens without a speech
	/// server never touch the audio session.
	func voiceController() -> VoiceController? {
		if let voice { return voice }
		guard store.supports(.speech), let client = store.client else { return nil }
		let store = self.store
		let sessionId = self.sessionId
		let controller = VoiceController(client: client, sessionId: sessionId, handlers: VoiceHandlers(
			send: { text in try await store.send(sessionId: sessionId, text: text) },
			answer: { ask, draft in try await store.answer(ask: ask, text: draft.text, answers: draft.answers) },
			interrupt: { try await store.stop(sessionId: sessionId) }))
		voice = controller
		return controller
	}

	var pendingAsk: DeckAsk? {
		store.asks.first { $0.sessionId == sessionId }
	}

	/// Follow the session's SSE stream: stored history first, then tool calls and
	/// token deltas as they land, folded into renderable items. Reconnects if the
	/// stream drops.
	func startPolling() {
		stopPolling()
		streamTask = Task { [weak self] in
			await self?.runStream()
		}
	}

	func stopPolling() {
		streamTask?.cancel()
		streamTask = nil
	}

	var isPolling: Bool { streamTask != nil }

	/// Leaving the session ends voice mode; playback must not outlive the
	/// screen that shows what is being read.
	func leave() {
		voice?.disable()
		stopPolling()
	}

	private func runStream() async {
		while !Task.isCancelled {
			// Checked each round: the server's capabilities can arrive after the
			// screen opens, and a missing stream route must not be retried forever.
			guard let client = store.client, store.supports(.stream) else {
				isLoadingTranscript = false
				return
			}
			isLoadingTranscript = !didLoadOnce
			do {
				for try await event in client.sessionEventStream(sessionId: sessionId) {
					if Task.isCancelled { return }
					switch event {
					case .snapshot(let events, let start):
						applySnapshot(events, start: start)
						refreshAgents()
					case .transcript(let event):
						// An assistant message ends the turn the deltas were
						// building, and arrives with the same text.
						if event["type"].string == "assistant", (event["parent_tool_use_id"].string ?? "").isEmpty { streamingText = "" }
						builder.append(event)
						showItems()
						voice?.hear(event)
						if SubagentsState.affects(event) { refreshAgents() }
					case .turnStart:
						streamingText = ""
					case .textDelta(let text):
						streamingText += text
					case .exit:
						refreshAgents()
					case .status:
						break
					}
				}
			} catch is CancellationError {
				return
			} catch {
				// Stream dropped; reconnect below. The recent history arrives again
				// with the next snapshot and is merged over what is already loaded.
			}
			if Task.isCancelled { return }
			isLoadingTranscript = false
			streamingText = ""
			try? await Task.sleep(for: .seconds(3))
		}
	}

	/// Re-read the server's fold of the session's subagents. Task events can come
	/// in bursts, so a change landing mid-fetch costs one more fetch, not one each.
	private func refreshAgents() {
		guard store.supports(.subagents), let client = store.client else { return }
		guard agentsFetch == nil else {
			agentsStale = true
			return
		}
		let id = sessionId
		agentsFetch = Task { [weak self] in
			repeat {
				self?.agentsStale = false
				if let fresh = try? await client.sessionAgents(sessionId: id), !Task.isCancelled { self?.agents = fresh }
			} while self?.agentsStale == true && !Task.isCancelled
			self?.agentsFetch = nil
		}
	}

	/// A fresh snapshot carries only the recent tail. Older pages already pulled
	/// in stay valid (the transcript is append-only), so keep them in front of
	/// the new tail rather than dropping the reader back to the recent window.
	private func applySnapshot(_ events: [JSONValue], start: Int) {
		if didLoadOnce, baseIndex < start, builder.events.count >= start - baseIndex {
			let older = Array(builder.events.prefix(start - baseIndex))
			builder.reset(with: older + events, startIndex: baseIndex)
		} else {
			builder.reset(with: events, startIndex: start)
			baseIndex = start
		}
		showItems()
		streamingText = ""
		didLoadOnce = true
		isLoadingTranscript = false
	}

	/// Pull the next older slice in front of what is loaded. Returns true when
	/// something was added, so the view can hold the reader's place.
	@discardableResult
	func loadOlder() async -> Bool {
		guard !isLoadingOlder, baseIndex > 0, store.supports(.history), let client = store.client else { return false }
		isLoadingOlder = true
		defer { isLoadingOlder = false }
		do {
			let slice = try await client.transcriptRange(
				sessionId: sessionId, before: baseIndex, limit: Self.historyChunk)
			let added = baseIndex - slice.start
			guard added > 0, slice.events.count == added else {
				baseIndex = min(baseIndex, slice.start)
				return false
			}
			builder.prepend(contentsOf: slice.events, startIndex: slice.start)
			baseIndex = slice.start
			showItems()
			return true
		} catch {
			report(error)
			return false
		}
	}

	/// The row for a transcript event index (a search hit), loading older
	/// history until it is present. Nil when the index can't be reached.
	func itemId(forEventIndex index: Int) async -> String? {
		var pulls = 0
		while baseIndex > index, pulls < 40 {
			pulls += 1
			if await loadOlder() == false { break }
		}
		let prefix = "\(index):"
		// A subagent's step is inside its card, so land on the card.
		let thread = builder.thread
		guard let hit = builder.items.first(where: { $0.id == String(index) || $0.id.hasPrefix(prefix) }) else { return nil }
		return thread.threadItemId(for: hit.id)
	}

	/// The main thread, with each subagent's items under its launching call.
	private func showItems() {
		let thread = builder.thread
		items = thread.items
		steps = thread.steps
	}

	/// The bytes of a stored attachment, fetched once per file for this screen.
	func imageData(for image: TranscriptImage) async -> Data? {
		if let inline = image.data, let data = Data(base64Encoded: inline) { return data }
		guard let file = image.file else { return nil }
		if let cached = imageCache[file] { return cached }
		guard store.supports(.images), let client = store.client,
			let data = try? await client.imageData(sessionId: sessionId, file: file)
		else { return nil }
		imageCache[file] = data
		return data
	}

	/// The servable files among a message's mentions, in order. Deck is asked
	/// once per path; a failed ask is asked again next time.
	func files(for paths: [String]) async -> [FileInfo] {
		guard store.supports(.files) else { return [] }
		let unknown = paths.filter { !filesAsked.contains($0) }
		if !unknown.isEmpty, let client = store.client,
			let found = try? await client.statFiles(sessionId: sessionId, paths: unknown)
		{
			for file in found { fileInfo[file.path] = file }
			filesAsked.formUnion(unknown)
		}
		return paths.compactMap { fileInfo[$0] }
	}

	func fileData(path: String) async -> Data? {
		if let cached = fileCache[path] { return cached }
		guard store.supports(.files), let client = store.client, let data = try? await client.fileData(sessionId: sessionId, path: path) else { return nil }
		fileCache[path] = data
		return data
	}

	/// A mentioned file copied into a temp location, for Quick Look and sharing.
	func localCopy(of file: FileInfo) async -> URL? {
		guard let data = await fileData(path: file.path) else { return nil }
		let dir = FileManager.default.temporaryDirectory.appendingPathComponent("deck-files/\(sessionId)", isDirectory: true)
		let url = dir.appendingPathComponent(file.name)
		do {
			try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
			try data.write(to: url, options: .atomic)
		} catch {
			return nil
		}
		return url
	}

	func stop() async {
		do {
			try await store.stop(sessionId: sessionId)
		} catch {
			report(error)
		}
	}

	func sendQuickMessage(text: String) async {
		do {
			try await store.sendQuickMessage(sessionId: sessionId, text: text)
		} catch {
			report(error)
		}
	}

	/// Submit a completed answer draft: the text the agent reads plus the picks
	/// deck records against the question.
	func answer(ask: DeckAsk, draft: AskAnswerDraft) async {
		guard draft.isComplete else { return }
		do {
			try await store.answer(ask: ask, text: draft.text, answers: draft.answers)
		} catch {
			report(error)
		}
	}

	func review(decision: String, body: String?) async {
		guard let client = store.client else { return }
		do {
			_ = try await client.review(sessionId: sessionId, decision: decision, body: body)
			await store.refreshSessions()
		} catch {
			report(error)
		}
	}

	func merge(method: String = "squash", deleteBranch: Bool = true) async {
		guard let client = store.client else { return }
		do {
			_ = try await client.merge(sessionId: sessionId, method: method, deleteBranch: deleteBranch)
			await store.refreshSessions()
		} catch {
			report(error)
		}
	}

	func changeAgent(_ kind: String) async {
		do {
			try await store.changeAgent(sessionId: sessionId, kind: kind)
		} catch {
			report(error)
		}
	}

	func sendComposer(text: String, images: [DeckImage]) async -> Bool {
		do {
			if images.isEmpty {
				try await store.send(sessionId: sessionId, text: text)
			} else {
				try await store.sendImages(sessionId: sessionId, text: text, images: images)
			}
			return true
		} catch {
			report(error)
			return false
		}
	}

	func changeModel(_ model: String?) async {
		do {
			try await store.changeModel(sessionId: sessionId, model: model)
		} catch {
			report(error)
		}
	}

	func changeEffort(_ effort: String?) async {
		do {
			try await store.changeEffort(sessionId: sessionId, effort: effort)
		} catch {
			report(error)
		}
	}

	/// Respawn claude with the current CLI config on the next message; the
	/// conversation carries on.
	func restart() async {
		do {
			try await store.restart(sessionId: sessionId)
		} catch {
			report(error)
		}
	}

	func dismissPR() async {
		do {
			try await store.dismissPR(sessionId: sessionId)
		} catch {
			report(error)
		}
	}

	/// Summarise the history and free the context window. Runs as a turn of its
	/// own, so the transcript shows it happening.
	func compact() async {
		do {
			try await store.compact(sessionId: sessionId)
		} catch {
			report(error)
		}
	}

	/// Returns true on success so the caller can dismiss.
	func delete(deleteWorktree: Bool, deleteBranch: Bool) async -> Bool {
		do {
			try await store.deleteSession(
				sessionId: sessionId, deleteWorktree: deleteWorktree, deleteBranch: deleteBranch)
			return true
		} catch {
			report(error)
			return false
		}
	}

	/// Surface an error to the user, but never for a cancelled request (a poll
	/// restart or leaving the screen cancels in-flight URLSession tasks, which
	/// would otherwise pop a spurious "cancelled" alert).
	private func report(_ error: Error) {
		if error is CancellationError { return }
		let nsError = error as NSError
		if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
		errorMessage = error.localizedDescription
	}
}
