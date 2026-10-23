import SwiftUI
import WatchKit
import DeckKit

/// Voice mode on the wrist: reads new replies while this screen is open and
/// holds the button to talk back. Foreground only; leaving the screen ends it.
struct VoiceView: View {
	@Environment(DeckStore.self) private var store
	let session: SessionDigest

	@State private var voice: VoiceController?
	@State private var streamTask: Task<Void, Never>?
	@State private var holding = false

	var body: some View {
		VStack(spacing: 10) {
			if let voice {
				VStack(spacing: 4) {
					Text(statusLabel(voice))
						.font(.caption2)
						.foregroundStyle(.secondary)
					Text(caption(voice))
						.font(.footnote)
						.multilineTextAlignment(.center)
						.lineLimit(4)
					if let error = voice.error, !error.isEmpty {
						Text(error).font(.caption2).foregroundStyle(.red).lineLimit(2)
					}
				}
				Spacer(minLength: 0)
				talkButton(voice)
				HStack {
					Button {
						voice.skip()
					} label: {
						Image(systemName: "forward.end")
					}
					.disabled(voice.status != .speaking)
					Button(role: .destructive) {
						voice.stop()
					} label: {
						Image(systemName: "stop.fill")
					}
				}
				.buttonStyle(.bordered)
				.controlSize(.small)
			} else {
				ProgressView()
			}
		}
		.padding(.horizontal)
		.navigationTitle("Voice")
		.task { await start() }
		.onDisappear { end() }
	}

	private func statusLabel(_ voice: VoiceController) -> String {
		switch voice.status {
		case .speaking: return "Reading"
		case .listening: return "Listening"
		case .transcribing: return "Transcribing"
		case .idle: return voice.ask != nil ? "Your answer?" : (voice.canRead ? "Voice on" : "No speech server")
		}
	}

	private func caption(_ voice: VoiceController) -> String {
		if !voice.caption.isEmpty { return voice.caption }
		if voice.ask != nil { return "Say an option or a reply." }
		return voice.canListen ? "Hold to talk." : "Replies are read aloud."
	}

	private func talkButton(_ voice: VoiceController) -> some View {
		ZStack {
			Circle()
				.stroke(Color.red.opacity(0.5), lineWidth: 2)
				.scaleEffect(1 + CGFloat(voice.level) * 0.5)
				.opacity(voice.recording ? 1 : 0)
			Circle().fill(voice.recording ? Color.red : Color.accentColor)
			Image(systemName: "mic.fill").font(.title3).foregroundStyle(.white)
		}
		.frame(width: 56, height: 56)
		.contentShape(Circle())
		.opacity(voice.canListen ? 1 : 0.4)
		.accessibilityLabel(voice.recording ? "Release to send" : "Hold to talk")
		.accessibilityAddTraits(.isButton)
		.gesture(
			DragGesture(minimumDistance: 0)
				.onChanged { value in
					guard voice.canListen, voice.status != .transcribing else { return }
					if !holding {
						holding = true
						WKInterfaceDevice.current().play(.start)
						voice.startRecording()
					}
					if abs(value.translation.width) > 50 || abs(value.translation.height) > 50 {
						holding = false
						voice.cancelRecording()
					}
				}
				.onEnded { _ in
					guard holding else { return }
					holding = false
					WKInterfaceDevice.current().play(.stop)
					voice.stopRecording()
				}
		)
	}

	private func start() async {
		guard let client = store.client, voice == nil else { return }
		let store = self.store
		let sessionId = session.id
		let controller = VoiceController(client: client, sessionId: sessionId, handlers: VoiceHandlers(
			send: { text in try await store.send(sessionId: sessionId, text: text, voice: true) },
			answer: { ask, draft in try await store.answer(ask: ask, text: draft.text, answers: draft.answers) },
			interrupt: { try await store.stop(sessionId: sessionId) }))
		voice = controller
		await controller.loadCapabilities()
		controller.enable()
		// Only live events are read: the snapshot is history, not news.
		streamTask = Task {
			while !Task.isCancelled {
				do {
					for try await event in client.sessionEventStream(sessionId: sessionId) {
						if Task.isCancelled { return }
						switch event {
						case .transcript(let event): controller.hear(event)
						case .status(let status): controller.turnRunning = status == "running"
						default: break
						}
					}
				} catch is CancellationError {
					return
				} catch {
					try? await Task.sleep(for: .seconds(3))
				}
			}
		}
	}

	private func end() {
		streamTask?.cancel()
		streamTask = nil
		voice?.disable()
	}
}
