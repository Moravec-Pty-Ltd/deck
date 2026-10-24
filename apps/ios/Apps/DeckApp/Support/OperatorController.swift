#if os(iOS)
import AudioToolbox
#endif
import Foundation
import Observation
import DeckKit
import DeckLocalModel

/// One entry of the operator conversation as the Operator tab shows it.
struct OperatorEntry: Identifiable {
	enum Role { case user, operatorReply, announcement, error }
	let id = UUID()
	let role: Role
	let text: String
	let actions: [String]
	let at: Date
}

/// The hands-free operator on the phone: a VoiceController whose spoken
/// takes go to `/api/agent/operator` instead of a session, with a wake word in
/// front of the open mic. Turned on, the mic monitors continuously: the
/// wake-word recogniser reads the tap, and the energy detector records a
/// take only while the gate is open, which "hey deck" opens and an 8 s
/// follow-up window after each reply keeps open. Hold-to-talk works at any
/// time. While on, the operator's own announcements stream in and are read.
///
/// The Mac shares this with no wake word and no open mic: turned on, it reads
/// replies and announcements, and listens only while the talk button is held.
@MainActor
@Observable
final class OperatorController {
	static let shared = OperatorController()

	private(set) var voice: VoiceController?
	private(set) var entries: [OperatorEntry] = []
	private(set) var busy = false
	/// Whether this device can think for itself, and what to say when it
	/// cannot. There is no server model to be "configured" any more.
	///
	/// A downloaded model satisfies this on its own: it is this device
	/// thinking, and it does not care whether Apple Intelligence is eligible or
	/// even switched on.
	var availability: OperatorAvailability {
		LocalModelStore.shared.isActive ? .available : OperatorBrain.availability
	}

	/// Which model is answering, for the status line.
	var modelName: String {
		LocalModelStore.shared.isActive
			? LocalModelCatalogue.displayName(for: LocalModelStore.shared.chosenId)
			: "Apple on-device"
	}
	/// The gate: true from the wake word until the follow-up window closes.
	private(set) var awake = false
	private(set) var wakeWordAvailable = AppPlatform.current.hasWakeWord
	/// What the wake-word recogniser last heard, and its last complaint.
	private(set) var wakeHeard = ""
	private(set) var wakeError = ""
	private(set) var paused = false
	var enabled: Bool { voice?.enabled == true }

	private var client: DeckClient?
	private var brain: OperatorBrain?
	private weak var store: DeckStore?
	#if os(iOS)
	private let wake = WakeWordListener()
	#endif
	private var followUp: Task<Void, Never>?
	/// Sessions the operator speaks up about: any that has run a turn since it
	/// came on. Without this it would narrate every session on the machine.
	private var followed = Set<String>()

	static let followUpSeconds = 8.0

	private init() {}

	func configure(client: DeckClient?, store: DeckStore) {
		self.store = store
		guard client !== self.client else { return }
		self.client = client
		voice = nil
		brain = nil
		guard let client else { return }
		brain = OperatorBrain(client: client)
		adoptLocalModel()
		let controller = VoiceController(client: client, sessionId: "operator", handlers: VoiceHandlers(
			send: { [weak self] text in await self?.send(text) },
			answer: { _, _ in },
			interrupt: { }))
		controller.persistsSettings = false
		controller.acknowledges = false
		controller.onPlaybackFinished = { [weak self] in self?.openFollowUp() }
		voice = controller
		#if os(iOS)
		controller.onAudioBuffer = { [wake] buffer in wake.append(buffer) }
		wake.onWake = { [weak self] in self?.heardWakeWord() }
		wake.onHeard = { [weak self] text in
			self?.wakeHeard = String(text.suffix(60))
			self?.voice?.heard(text)
		}
		wake.onError = { [weak self] text in self?.wakeError = text }
		wake.onTaskStart = { [weak self] in self?.voice?.heard("") }
		#endif
		Task { await controller.loadCapabilities() }
	}

	// MARK: - On / off

	func turnOn() {
		guard let voice, client != nil else { return }
		awake = false
		wakeHeard = ""
		wakeError = ""
		#if os(iOS)
		if inCar { listenOnTap(voice) } else { listenForWakeWord(voice) }
		#else
		listenOnTap(voice)
		#endif
		if let store { listen(store) }
	}

	private func listenOnTap(_ voice: VoiceController) {
		voice.settings.handsFree = false
		voice.listenGate = true
		voice.enable()
	}

	// MARK: - CarPlay

	/// CarPlay allows no wake word: while the car is connected the operator
	/// listens only on a tap from its CarPlay screen, and the phone's open mic
	/// stays off until the car goes.
	private(set) var inCar = false
	private var onBeforeCar = false

	func enterCar() {
		guard !inCar else { return }
		// Paused for a session's voice mode on the phone counts as on.
		onBeforeCar = enabled || paused
		paused = false
		turnOff()
		inCar = true
	}

	func leaveCar() {
		guard inCar else { return }
		turnOff()
		inCar = false
		if onBeforeCar { turnOn() }
	}

	#if os(iOS)
	private func listenForWakeWord(_ voice: VoiceController) {
		// The operator listens continuously; hands-free is what makes the
		// controller keep the mic open between takes. The gate stays shut until
		// the wake word is heard, or opens for good if there is no recogniser.
		voice.settings.handsFree = true
		voice.listenGate = false
		voice.enable()
		Task {
			let allowed = await Self.speechAllowed()
			if allowed { wake.start() } else { wakeError = "Speech recognition permission was not granted; allow it in Settings > deck." }
			wakeWordAvailable = allowed && wake.available
			if !wakeWordAvailable { voice.listenGate = true }
		}
	}

	// Speech authorisation can sit unanswered (a simulator, a dismissed
	// prompt); after a while the operator carries on without a wake word.
	private static func speechAllowed() async -> Bool {
		await withTaskGroup(of: Bool.self) { group in
			group.addTask { await WakeWordListener.authorize() }
			group.addTask {
				try? await Task.sleep(for: .seconds(15))
				return false
			}
			let first = await group.next() ?? false
			group.cancelAll()
			return first
		}
	}
	#endif

	func turnOff() {
		followUp?.cancel()
		store?.onFeedEvent = nil
		followed.removeAll()
		#if os(iOS)
		wake.stop()
		#endif
		voice?.disable()
		awake = false
	}

	/// A session's own voice mode needs the mic; the operator steps aside and
	/// comes back when that ends.
	func pause() {
		guard enabled, !paused else { return }
		paused = true
		turnOff()
	}

	func resume() {
		guard paused else { return }
		paused = false
		turnOn()
	}

	// MARK: - Wake and follow-up

	#if os(iOS)
	private func heardWakeWord() {
		guard let voice, voice.enabled, !paused else { return }
		wakeHeard = "hey deck"
		AudioServicesPlaySystemSound(1113)
		voice.stopSpeaking()
		openGate()
		// The command usually follows in the same breath, so start the take
		// now rather than waiting for the detector's next opening edge.
		if !voice.recording { voice.startRecording() }
	}
	#endif

	private func openGate() {
		awake = true
		voice?.listenGate = true
		followUp?.cancel()
	}

	private func openFollowUp() {
		guard voice?.enabled == true else { return }
		openGate()
		followUp = Task { [weak self] in
			try? await Task.sleep(for: .seconds(Self.followUpSeconds))
			guard !Task.isCancelled else { return }
			self?.closeGate()
		}
	}

	private func closeGate() {
		guard let voice, !voice.recording, voice.status != .transcribing else {
			// Mid-take: try again once it is over.
			followUp = Task { [weak self] in
				try? await Task.sleep(for: .seconds(2))
				guard !Task.isCancelled else { return }
				self?.closeGate()
			}
			return
		}
		awake = false
		voice.listenGate = !wakeWordAvailable
	}

	// MARK: - Conversation

	func send(_ text: String) async {
		let message = text.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !message.isEmpty, !busy, let brain else { return }
		busy = true
		followUp?.cancel()
		entries.append(OperatorEntry(role: .user, text: message, actions: [], at: Date()))
		defer { busy = false }
		do {
			let reply = try await brain.send(message)
			entries.append(OperatorEntry(role: .operatorReply, text: reply, actions: [], at: Date()))
			speak(reply)
		} catch {
			entries.append(OperatorEntry(role: .error, text: Self.failureText(error), actions: [], at: Date()))
			openFollowUp()
		}
	}

	private func speak(_ text: String) {
		guard let voice else { return }
		if voice.enabled { voice.speak(text) } else { voice.readAloud(text) }
	}

	func reset() async {
		brain?.reset()
		entries = []
	}

	// MARK: - Announcements

	/// What the operator says on its own: a session's new question with its
	/// numbered options (the next thing said answers it), and a finished turn
	/// as a one-sentence summary. This used to arrive on its own SSE stream
	/// from deck, which decided what was worth saying; now that the operator
	/// thinks on the device, it reads the event log the app already follows and
	/// decides for itself.
	private func listen(_ store: DeckStore) {
		store.onFeedEvent = { [weak self] event in self?.heard(event, store: store) }
	}

	private func heard(_ event: DeckEvent, store: DeckStore) {
		guard enabled, let sessionId = event.sessionId else { return }
		let title = store.sessions.first { $0.id == sessionId }?.title ?? "A session"

		switch event.type {
		case "awaiting-input" where event.awaitingInput == true:
			guard let question = event.questions?.first else { return }
			followed.insert(sessionId)
			let options = question.options?.map(\.label) ?? []
			let numbered = options.enumerated().map { "\($0.offset + 1), \($0.element)" }.joined(separator: ". ")
			announce("\(title) is asking: \(question.question)" + (numbered.isEmpty ? "" : " Options: \(numbered)."))
		case "turn-finished":
			// Only sessions the user has had something to do with since the
			// operator came on, or it would narrate the whole machine.
			guard followed.contains(sessionId) else { return }
			Task { [weak self] in await self?.announceTurn(sessionId, title: title) }
		case "status" where event.status == .error:
			announce("\(title) hit an error.")
		default:
			break
		}
	}

	/// Summarising needs the model, so it happens off the feed handler and only
	/// says anything if there was a reply to summarise.
	private func announceTurn(_ sessionId: String, title: String) async {
		guard let brain, let client else { return }
		guard let detail = try? await client.session(id: sessionId),
			let reply = detail.lastResult, !reply.isEmpty else { return }
		let summary = (try? await brain.summarise(reply: reply, sessionTitle: title)) ?? "\(title) finished."
		announce(summary)
	}

	private func announce(_ text: String) {
		entries.append(OperatorEntry(role: .announcement, text: text, actions: [], at: Date()))
		speak(text)
	}

	/// Point the brain at whichever model is chosen, or back at Apple's own.
	///
	/// Called on configure and whenever the choice changes. Idempotent: the
	/// brain compares the id and only starts the conversation again on a real
	/// change.
	func adoptLocalModel() {
		let store = LocalModelStore.shared
		brain?.useModel(store.operatorModel, id: store.chosenId)
	}

	/// A session the user drove by voice is one the operator should report on.
	func follow(_ sessionId: String) {
		followed.insert(sessionId)
	}

	/// The thinking is local now, so a failure is either this device's model or
	/// deck being unreachable, never a model deck was asked to run.
	static func failureText(_ error: Error) -> String {
		// Only Apple's model has availability to complain about. A downloaded
		// one that is active has already loaded, so a failure here is the
		// request, not the model being unavailable.
		if !LocalModelStore.shared.isActive, let reason = OperatorBrain.availability.reason { return reason }
		if case DeckError.http(let status, _) = error {
			if status == 401 { return "deck rejected the sign-in; sign in again." }
			return "deck answered \(status)."
		}
		return error.localizedDescription
	}
}
