import CarPlay
import DeckKit

/// The CarPlay scene. The car's voice-based conversation category is iOS
/// 26.4 and later; below that the scene shows nothing and the app is as before.
final class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
	private var screens: AnyObject?

	func templateApplicationScene(_ scene: CPTemplateApplicationScene, didConnect interfaceController: CPInterfaceController) {
		guard #available(iOS 26.4, *) else { return }
		screens = CarPlayScreens(interfaceController)
	}

	func templateApplicationScene(_ scene: CPTemplateApplicationScene, didDisconnect interfaceController: CPInterfaceController) {
		if #available(iOS 26.4, *) { (screens as? CarPlayScreens)?.disconnect() }
		screens = nil
	}
}

/// deck in the car: a list of Operator and the working sessions, each opening
/// a voice screen. Voice screens are hands-free unless the "Hands-free in the
/// car" setting is off, and replies are spoken, never shown. The phone's
/// operator stops listening while the car is connected.
@available(iOS 26.4, *)
@MainActor
private final class CarPlayScreens: NSObject, CPInterfaceControllerDelegate {
	private let interface: CPInterfaceController
	private let home = CPListTemplate(title: "deck", sections: [])
	private var voiceScreen: CPVoiceControlTemplate?
	private var voice: VoiceController?
	private var working: () -> Bool = { false }
	private var handsFree = true
	/// The open session's stream, which feeds its voice controller.
	private var session: SessionDetailViewModel?
	// Each voice screen gets a number, so an observation of a closed one stops.
	private var voiceRun = 0
	private var connected = true

	private var store: DeckStore { DeckAppMain.store }
	private var operatorController: OperatorController { OperatorController.shared }

	init(_ interface: CPInterfaceController) {
		self.interface = interface
		super.init()
		interface.delegate = self
		// The phone's window may never have opened, so nothing has started the store.
		if store.isSignedIn, store.connection == .signedOut { store.start() }
		operatorController.configure(client: store.client, store: store)
		operatorController.enterCar()
		followHome()
		interface.setRootTemplate(home, animated: false, completion: nil)
	}

	func disconnect() {
		connected = false
		closeVoice()
		operatorController.leaveCar()
	}

	// MARK: - Home

	private func followHome() {
		guard connected else { return }
		withObservationTracking { updateHome() } onChange: {
			Task { @MainActor [weak self] in self?.followHome() }
		}
	}

	private func updateHome() {
		guard store.isSignedIn else {
			home.updateSections([CPListSection(items: [CPListItem(text: "Sign in to deck on your iPhone", detailText: nil)])])
			return
		}
		let operatorItem = CPListItem(text: "Operator", detailText: "Ask about or drive any session", image: UIImage(systemName: "waveform"))
		operatorItem.handler = { [weak self] _, done in
			self?.openOperator()
			done()
		}
		let asking = Set(store.asks.map(\.sessionId))
		let limit = Int(CPListTemplate.maximumItemCount) - 1
		let sessions = CarPlayHome.sessions(store.activeSessions, asks: store.asks, limit: limit).map { session in
			let isAsking = asking.contains(session.id) || session.awaitingInput == true
			let item = CPListItem(
				text: SessionDetailViewModel.title(of: session, id: session.id),
				detailText: isAsking ? "Has a question" : nil,
				image: UIImage(systemName: isAsking ? "questionmark.bubble.fill" : "bubble.left"))
			item.handler = { [weak self] _, done in
				self?.openSession(session.id)
				done()
			}
			return item
		}
		home.updateSections([CPListSection(items: [operatorItem] + sessions)])
	}

	// MARK: - Voice screens

	private func openOperator() {
		operatorController.configure(client: store.client, store: store)
		operatorController.turnOn()
		guard let voice = operatorController.voice else { return }
		let controller = operatorController
		present(voice, title: "Operator") { controller.busy }
	}

	private func openSession(_ id: String) {
		let model = SessionDetailViewModel(sessionId: id, store: store)
		guard let voice = model.voiceController() else { return }
		model.startPolling()
		session = model
		// Never written back, so the car leaves the phone's own setting alone.
		voice.persistsSettings = false
		voice.settings.handsFree = VoiceSettings.load().handsFreeInCar
		voice.bargeIn = false
		if voice.capabilities == nil { Task { await voice.loadCapabilities() } }
		voice.enable()
		if let ask = store.asks.first(where: { $0.sessionId == id }) { voice.startAsk(ask) }
		present(voice, title: SessionDetailViewModel.title(of: model.session, id: id)) { voice.turnRunning }
	}

	private func present(_ voice: VoiceController, title: String, working: @escaping () -> Bool) {
		voiceRun += 1
		let run = voiceRun
		self.voice = voice
		self.working = working
		let handsFree = voice.settings.handsFree
		self.handsFree = handsFree
		let states = CarPlayHome.VoiceState.states(handsFree: handsFree).map { state in
			let item = CPVoiceControlState(
				identifier: state.rawValue, titleVariants: ["\(title): \(state.title)", state.title], image: nil, repeats: false)
			let tap = state.tap(handsFree: handsFree)
			let image = UIImage(systemName: Self.symbol(tap)) ?? UIImage()
			let button = CPButton(image: image) { [weak self] _ in self?.press(tap) }
			button.title = state.buttonTitle(handsFree: handsFree)
			item.actionButtons = [button]
			return item
		}
		let screen = CPVoiceControlTemplate(voiceControlStates: states)
		voiceScreen = screen
		interface.pushTemplate(screen, animated: true) { [weak self] _, _ in self?.followVoice(run) }
	}

	private static func symbol(_ tap: CarPlayHome.VoiceState.Tap) -> String {
		switch tap {
		case .talk: "mic.fill"
		case .send: "arrow.up.circle.fill"
		case .pause: "pause.fill"
		case .resume: "play.fill"
		}
	}

	// The button acts on what the voice is doing now, not the state it was
	// built for, in case the screen has yet to catch up.
	private func press(_ tap: CarPlayHome.VoiceState.Tap) {
		guard let voice else { return }
		if voice.recording { return voice.stopRecording() }
		switch tap {
		case .talk: voice.startRecording()
		case .send: break
		// Switching hands-free closes or reopens the mic; setting it on again
		// also retries a mic that failed to open.
		case .pause:
			voice.settings.handsFree = false
			voice.stopSpeaking()
		case .resume:
			voice.settings.handsFree = true
			// Loading them starts listening once deck says it can transcribe.
			if !voice.canListen { Task { await voice.loadCapabilities() } }
		}
	}

	private func followVoice(_ run: Int) {
		guard run == voiceRun, let voice, let voiceScreen else { return }
		withObservationTracking {
			let state = CarPlayHome.VoiceState.of(
				voice.status, recording: voice.recording, working: working(), handsFree: handsFree).rawValue
			if voiceScreen.activeStateIdentifier != state { voiceScreen.activateVoiceControlState(withIdentifier: state) }
		} onChange: {
			Task { @MainActor [weak self] in self?.followVoice(run) }
		}
	}

	private func closeVoice() {
		if session != nil {
			session?.leave()
			session = nil
		} else if voice != nil {
			operatorController.turnOff()
		}
		voice = nil
		voiceScreen = nil
	}

	func templateDidDisappear(_ aTemplate: CPTemplate, animated: Bool) {
		if aTemplate === voiceScreen { closeVoice() }
	}
}
