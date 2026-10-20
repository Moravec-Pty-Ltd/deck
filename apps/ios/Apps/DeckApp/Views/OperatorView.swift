import SwiftUI
import DeckKit
import DeckUI

/// The Operator tab: the conversation with the hands-free operator, what it
/// did, whether it is listening for "hey deck" or awake for a command, the
/// voice bar for hold-to-talk, and a text field for typing to it. The Mac
/// shows it in its own window, without the wake word.
struct OperatorView: View {
	@Environment(DeckStore.self) private var store
	@State private var text = ""
	@FocusState private var composing: Bool
	@State private var confirmClear = false
	#if os(macOS)
	@State private var choosingModel = false
	private let leading = ToolbarItemPlacement.navigation
	private let trailing = ToolbarItemPlacement.primaryAction
	#else
	private let leading = ToolbarItemPlacement.topBarLeading
	private let trailing = ToolbarItemPlacement.topBarTrailing
	#endif

	private var operatorController: OperatorController { OperatorController.shared }

	var body: some View {
		NavigationStack {
			VStack(spacing: 0) {
				stateLine
				conversation
				if let voice = operatorController.voice, voice.enabled {
					Divider()
					VoiceBar(voice: voice)
				}
				Divider()
				composer
			}
			.navigationTitle("Operator")
			.toolbar {
				ToolbarItem(placement: leading) {
					Button {
						confirmClear = true
					} label: {
						Image(systemName: "trash")
					}
					.accessibilityLabel("Clear the conversation")
				}
				#if os(macOS)
				ToolbarItem(placement: trailing) {
					Button {
						choosingModel = true
					} label: {
						Label(operatorController.modelName, systemImage: "cpu")
					}
					.help("Choose the model the operator thinks with")
				}
				#endif
				ToolbarItem(placement: trailing) {
					Button {
						if operatorController.enabled { operatorController.turnOff() } else { operatorController.turnOn() }
					} label: {
						Image(systemName: operatorController.enabled ? "waveform.circle.fill" : "waveform.circle")
					}
					.disabled(operatorController.availability != .available)
					.accessibilityLabel(operatorController.enabled ? "Turn the operator off" : "Turn the operator on")
				}
			}
			// The button sits where a thumb lands; the log is the only record of
			// what the operator did, so a slip must not wipe it.
			.confirmationDialog("Clear the conversation?", isPresented: $confirmClear, titleVisibility: .visible) {
				Button("Clear", role: .destructive) { Task { await operatorController.reset() } }
			}
			#if os(macOS)
			.sheet(isPresented: $choosingModel) { modelSheet }
			#endif
			.onAppear { operatorController.configure(client: store.client, store: store) }
			.onChange(of: store.isSignedIn) { _, _ in operatorController.configure(client: store.client, store: store) }
		}
	}

	private var conversation: some View {
		ScrollViewReader { proxy in
			ScrollView {
				LazyVStack(alignment: .leading, spacing: 12) {
					if let reason = operatorController.availability.reason {
						Text(reason)
							.font(.footnote)
							.foregroundStyle(.secondary)
					} else if operatorController.entries.isEmpty {
						Text("\(Self.invitation) Ask what is going on, have a reply read, send a session an instruction, answer its question, or start a session with a skill.")
							.font(.footnote)
							.foregroundStyle(.secondary)
					}
					ForEach(operatorController.entries) { entry in
						row(entry).id(entry.id)
					}
					if operatorController.busy {
						ProgressView().controlSize(.small).padding(.leading, 10)
					}
					Color.clear.frame(height: 1).id("bottom")
				}
				.padding()
			}
			.scrollDismissesKeyboard(.interactively)
			.onChange(of: operatorController.entries.count) { _, _ in
				proxy.scrollTo("bottom", anchor: .bottom)
			}
			.onChange(of: operatorController.busy) { _, _ in
				proxy.scrollTo("bottom", anchor: .bottom)
			}
		}
	}

	@ViewBuilder
	private var stateLine: some View {
		if operatorController.enabled {
			VStack(spacing: 2) {
				HStack(spacing: 6) {
					Circle().fill(operatorController.awake ? Color.green : Color.blue).frame(width: 8, height: 8)
					Text(stateText)
				}
				// What the recogniser hears, so a wake word that does not land
				// can be seen: the phrase it makes of your voice, or its complaint.
				if !operatorController.wakeError.isEmpty {
					Text(operatorController.wakeError).font(.caption2).foregroundStyle(.red).lineLimit(2)
				} else if !operatorController.wakeHeard.isEmpty {
					Text("hears: \(operatorController.wakeHeard)").font(.caption2).lineLimit(1)
				}
			}
			.font(.caption)
			.foregroundStyle(.secondary)
			.frame(maxWidth: .infinity, alignment: .center)
			.padding(.vertical, 6)
			.padding(.horizontal)
			.background(.thinMaterial)
		}
	}

	private static var invitation: String {
		AppPlatform.current.hasWakeWord
			? "Turn it on and say \"hey deck\", or hold the mic."
			: "Type below, or turn it on and hold the mic to talk."
	}

	private var stateText: String {
		if !AppPlatform.current.hasWakeWord { return "On: hold the mic to talk" }
		if operatorController.awake { return "Awake: talk now" }
		if operatorController.wakeWordAvailable { return "Listening for \"hey deck\"" }
		return "Speech recognition is off; hold the mic to talk"
	}

	private func row(_ entry: OperatorEntry) -> some View {
		HStack {
			if entry.role == .user { Spacer(minLength: 40) }
			VStack(alignment: .leading, spacing: 4) {
				if entry.role == .announcement {
					Text("said").font(.caption2).foregroundStyle(.secondary)
				}
				Text(entry.text)
				ForEach(entry.actions, id: \.self) { action in
					Text(action).font(.caption).foregroundStyle(.secondary)
				}
			}
			.padding(10)
			.background(background(for: entry.role))
			.clipShape(RoundedRectangle(cornerRadius: DeckStyle.Radius.card))
			if entry.role != .user { Spacer(minLength: 40) }
		}
	}

	private func background(for role: OperatorEntry.Role) -> Color {
		switch role {
		case .user: return Color.accentColor.opacity(0.15)
		case .error: return Color.red.opacity(0.12)
		#if os(macOS)
		default: return Color(nsColor: .controlBackgroundColor)
		#else
		default: return Color(.secondarySystemBackground)
		#endif
		}
	}

	private var composer: some View {
		HStack(alignment: .bottom, spacing: 8) {
			TextField("Or type to the operator", text: $text, axis: .vertical)
				.textFieldStyle(.roundedBorder)
				.lineLimit(1...5)
				.focused($composing)
				.onSubmit(submit)
				.accessibilityIdentifier("operatorComposer")
			#if os(iOS)
			// The keyboard covers the tab bar and this is a root screen with no
			// back button, so it needs its own way down. A keyboard toolbar item
			// would do, but the system floats those over the composer.
			if composing {
				Button {
					composing = false
				} label: {
					Image(systemName: "keyboard.chevron.compact.down")
						.font(.title3)
				}
				.accessibilityLabel("Hide the keyboard")
			}
			#endif
			Button(action: submit) {
				Image(systemName: "arrow.up.circle.fill").font(.title2)
			}
			.disabled(text.trimmingCharacters(in: .whitespaces).isEmpty || operatorController.busy)
			.accessibilityLabel("Send to the operator")
		}
		.padding()
	}

	#if os(macOS)
	private var modelSheet: some View {
		NavigationStack {
			LocalModelView()
				.toolbar {
					ToolbarItem(placement: .confirmationAction) {
						Button("Done") { choosingModel = false }
					}
				}
		}
		.frame(minWidth: 480, minHeight: 520)
	}
	#endif

	private func submit() {
		let message = text
		text = ""
		Task { await operatorController.send(message) }
	}
}
