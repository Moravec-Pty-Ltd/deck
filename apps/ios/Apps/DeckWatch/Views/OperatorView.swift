import SwiftUI
import WatchKit
import DeckKit

/// The operator on the wrist: hold to talk and what you say goes to the
/// operator, whose reply is read back; while this page is showing, what it
/// says on its own (questions, finished turns, errors) is read too. No wake
/// word here: watchOS has no on-device speech recognition for one.
struct OperatorView: View {
	@Environment(DeckStore.self) private var store

	@State private var voice: VoiceController?
	@State private var announcements: Task<Void, Never>?
	@State private var holding = false
	@State private var busy = false
	@State private var lastSaid = ""
	@State private var lastHeard = ""

	var body: some View {
		VStack(spacing: 8) {
			if let voice {
				Text(statusLabel(voice))
					.font(.caption2)
					.foregroundStyle(.secondary)
				ScrollView {
					VStack(alignment: .leading, spacing: 4) {
						if !lastHeard.isEmpty {
							Text(lastHeard).font(.caption2).foregroundStyle(.secondary)
						}
						Text(caption(voice))
							.font(.footnote)
							.multilineTextAlignment(.leading)
						if let error = voice.error, !error.isEmpty {
							Text(error).font(.caption2).foregroundStyle(.red).lineLimit(2)
						}
					}
					.frame(maxWidth: .infinity, alignment: .leading)
				}
				talkButton(voice)
			} else {
				ProgressView()
			}
		}
		.padding(.horizontal)
		.navigationTitle("Operator")
		.task { await start() }
		.onDisappear { end() }
	}

	private func statusLabel(_ voice: VoiceController) -> String {
		if busy { return "Thinking" }
		switch voice.status {
		case .speaking: return "Speaking"
		case .listening: return "Listening"
		case .transcribing: return "Transcribing"
		case .idle: return voice.canListen ? "Operator on" : "No speech server"
		}
	}

	private func caption(_ voice: VoiceController) -> String {
		if voice.status == .speaking, !voice.caption.isEmpty { return voice.caption }
		if !lastSaid.isEmpty { return lastSaid }
		return voice.canListen ? "Hold to talk to the operator." : "Replies are read aloud."
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
		let controller = VoiceController(client: client, sessionId: "operator", handlers: VoiceHandlers(
			send: { text in await send(text, client: client) },
			answer: { _, _ in },
			interrupt: { }))
		controller.acknowledges = false
		voice = controller
		await controller.loadCapabilities()
		controller.enable()
		announcements = Task {
			while !Task.isCancelled {
				do {
					for try await announcement in client.operatorAnnouncements() {
						if Task.isCancelled { return }
						lastSaid = announcement.text
						controller.speak(announcement.text)
					}
				} catch is CancellationError {
					return
				} catch {
					try? await Task.sleep(for: .seconds(3))
				}
			}
		}
	}

	@MainActor
	private func send(_ text: String, client: DeckClient) async {
		lastHeard = text
		busy = true
		defer { busy = false }
		do {
			let reply = try await client.operatorSend(text, source: "watch")
			lastSaid = reply.text
			voice?.speak(reply.text)
		} catch {
			lastSaid = error.localizedDescription
		}
	}

	private func end() {
		announcements?.cancel()
		announcements = nil
		voice?.disable()
	}
}
