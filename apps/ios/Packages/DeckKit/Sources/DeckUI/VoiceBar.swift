import AVKit
import SwiftUI
import DeckKit
import DeckUI

/// The strip between the transcript and the composer while voice mode is on:
/// what is being read (or heard), hold-to-talk, Skip, Stop, and the per-device
/// settings (chattiness, read-out, hands-free, sensitivity, end of speech).
public struct VoiceBar: View {
	@Bindable var voice: VoiceController

	public init(voice: VoiceController) {
		self.voice = voice
	}

	public var body: some View {
		VStack(spacing: 8) {
			HStack(alignment: .center, spacing: 10) {
				VStack(alignment: .leading, spacing: 2) {
					VoiceStatusLine(voice: voice)
						.font(.caption)
					Text(voice.captionText)
						.font(.subheadline)
						.lineLimit(2)
				}
				Spacer(minLength: 4)
				Button {
					voice.skip()
				} label: {
					Image(systemName: "forward.end")
				}
				.disabled(voice.status != .speaking)
				.accessibilityLabel("Skip to the next reply")
				Button(role: .destructive) {
					voice.stop()
				} label: {
					Label("Stop", systemImage: "stop.fill")
				}
				.buttonStyle(.bordered)
				.tint(.red)
				.accessibilityLabel("Stop reading and interrupt")
				TalkButton(voice: voice, size: 48)
				#if os(iOS)
				RoutePicker()
					.frame(width: 28, height: 28)
					.accessibilityLabel("Audio output")
				#endif
				VoiceSettingsMenu(voice: voice)
			}
		}
		.padding(.horizontal)
		.padding(.vertical, 8)
		.deckGlass(in: Rectangle())
	}
}

/// Voice mode spread over the flat half of a half-open foldable: the status
/// and caption large enough to read from the upright half, the talk button
/// where a thumb rests.
public struct VoiceDeck: View {
	@Bindable var voice: VoiceController

	public init(voice: VoiceController) {
		self.voice = voice
	}

	public var body: some View {
		VStack(spacing: 18) {
			VoiceStatusLine(voice: voice)
				.font(.subheadline)
			Text(voice.captionText)
				.font(.title3)
				.multilineTextAlignment(.center)
				.lineLimit(4)
				.frame(maxWidth: 520)
			HStack(spacing: 28) {
				Button {
					voice.skip()
				} label: {
					Image(systemName: "forward.end")
						.font(.title2)
						.frame(width: 44, height: 44)
				}
				.disabled(voice.status != .speaking)
				.accessibilityLabel("Skip to the next reply")
				TalkButton(voice: voice, size: 96)
				Button(role: .destructive) {
					voice.stop()
				} label: {
					Image(systemName: "stop.fill")
						.font(.title2)
						.frame(width: 44, height: 44)
				}
				.buttonStyle(.bordered)
				.tint(.red)
				.accessibilityLabel("Stop reading and interrupt")
			}
			HStack(spacing: 20) {
				#if os(iOS)
				RoutePicker()
					.frame(width: 28, height: 28)
					.accessibilityLabel("Audio output")
				#endif
				VoiceSettingsMenu(voice: voice)
					.font(.title3)
			}
		}
		.padding()
		.frame(maxWidth: .infinity)
	}
}

/// The status dot and label with the output route and any error, as both the
/// bar and the deck lead with.
struct VoiceStatusLine: View {
	let voice: VoiceController

	var body: some View {
		HStack(spacing: 6) {
			Circle().fill(voice.dotColor).frame(width: 8, height: 8)
			Text(voice.statusLabel).lineLimit(1).fixedSize()
			if !voice.outputRoute.isEmpty {
				Text("· \(voice.outputRoute)").lineLimit(1)
			}
			if let error = voice.error, !error.isEmpty {
				Text("· \(error)").foregroundStyle(.red).lineLimit(1)
			}
		}
		.lineLimit(1)
		.foregroundStyle(.secondary)
	}
}

extension VoiceController {
	public var captionText: String {
		if !caption.isEmpty { return caption }
		if ask != nil { return "Say an option, its number, or a reply." }
		return settings.handsFree && supportsHandsFree ? "Talk whenever you like." : "Hold the button to talk."
	}

	public var statusLabel: String {
		switch status {
		case .speaking: return "Reading"
		case .listening: return settings.handsFree && !recording ? "Hands-free" : "Listening"
		case .transcribing: return "Transcribing"
		case .idle: return ask != nil ? "Waiting for your answer" : "Voice on"
		}
	}

	public var dotColor: Color {
		switch status {
		case .speaking: return .blue
		case .listening: return recording ? .red : .green
		case .transcribing: return .orange
		case .idle: return .green
		}
	}
}

/// Hold to talk; release inside sends, drag off cancels; a quick tap toggles
/// a long take (tap again to send).
struct TalkButton: View {
	@Bindable var voice: VoiceController
	var size: CGFloat

	@State private var holding = false
	@State private var pressedAt: Date?
	@State private var toggled = false

	var body: some View {
		ZStack {
			Circle()
				.stroke(Color.red.opacity(0.5), lineWidth: 2)
				.scaleEffect(1 + CGFloat(voice.level) * 0.6)
				.opacity(voice.recording ? 1 : 0)
			Circle()
				.fill(voice.recording ? Color.red : Color.accentColor)
			// Fixed to the circle, which is sized by the caller: a Dynamic Type
			// glyph would outgrow it at the larger accessibility sizes.
			Image(systemName: "mic.fill")
				.font(.system(size: size * 0.4))
				.foregroundStyle(.white)
		}
		.frame(width: size, height: size)
		.contentShape(Circle())
		.opacity(voice.canListen ? 1 : 0.4)
		.gesture(
			DragGesture(minimumDistance: 0)
				.onChanged { value in
					guard voice.canListen, voice.status != .transcribing else { return }
					if !holding {
						holding = true
						pressedAt = Date()
						if toggled {
							toggled = false
							voice.stopRecording()
						} else {
							voice.startRecording()
						}
					}
					let slack = max(60, size)
					let inside = abs(value.translation.width) < slack && abs(value.translation.height) < slack
					if !inside, voice.recording, !toggled {
						holding = false
						voice.cancelRecording()
					}
				}
				.onEnded { _ in
					guard holding else { return }
					holding = false
					let brief = Date().timeIntervalSince(pressedAt ?? Date()) < 0.25
					if brief, voice.recording {
						toggled = true
					} else if voice.recording {
						voice.stopRecording()
					}
				}
		)
		.accessibilityLabel(voice.recording ? "Release to send" : "Hold to talk")
		.accessibilityAddTraits(.isButton)
	}
}

struct VoiceSettingsMenu: View {
	@Bindable var voice: VoiceController

	var body: some View {
		Menu {
			Picker("Read", selection: Binding(
				get: { voice.settings.chattiness },
				set: { voice.settings.chattiness = $0 })) {
				ForEach(Chattiness.allCases, id: \.self) { Text($0.label).tag($0) }
			}
			Picker("Long replies", selection: Binding(
				get: { voice.settings.readOut },
				set: { voice.settings.readOut = $0 })) {
				ForEach(ReadOut.allCases, id: \.self) { Text($0.label).tag($0) }
			}
			Toggle("Working sound", isOn: Binding(
				get: { voice.settings.workingCue },
				set: { voice.settings.workingCue = $0 }))
			Toggle("Announce tool calls", isOn: Binding(
				get: { voice.settings.announceTools },
				set: { voice.settings.announceTools = $0 }))
			if voice.supportsHandsFree {
				Toggle("Hands-free", isOn: Binding(
					get: { voice.settings.handsFree },
					set: { voice.settings.handsFree = $0 }))
					.disabled(!voice.canListen)
				if voice.settings.handsFree {
					Picker("Sensitivity", selection: Binding(
						get: { voice.settings.sensitivity },
						set: { voice.settings.sensitivity = $0 })) {
						ForEach(VadSensitivity.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) }
					}
					Picker("End of speech", selection: Binding(
						get: { voice.settings.endOfSpeech },
						set: { voice.settings.endOfSpeech = $0 })) {
						ForEach(EndOfSpeech.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) }
					}
				}
			}
		} label: {
			Image(systemName: "slider.horizontal.3")
		}
		.accessibilityLabel("Voice settings")
	}
}

#if os(iOS)
/// The system's output picker (speaker, AirPods, AirPlay), so the route can
/// be forced when the automatic one is wrong. The Mac picks its output in
/// Control Center, so it has none here.
private struct RoutePicker: UIViewRepresentable {
	func makeUIView(context: Context) -> AVRoutePickerView {
		let view = AVRoutePickerView()
		view.prioritizesVideoDevices = false
		view.tintColor = UIColor.secondaryLabel
		return view
	}

	func updateUIView(_ uiView: AVRoutePickerView, context: Context) {}
}
#endif
