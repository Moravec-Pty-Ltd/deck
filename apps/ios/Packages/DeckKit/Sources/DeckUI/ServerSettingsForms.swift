import SwiftUI
import DeckKit

// Sections editing the deck server's settings, meant to sit inside a Form. They
// hold no app state, so the iOS Settings screen and the Mac Settings scene
// share them. Every save PATCHes only its own block.

extension View {
	fileprivate func plainEntry() -> some View {
		#if os(iOS)
		self.textInputAutocapitalization(.never).autocorrectionDisabled()
		#else
		self.autocorrectionDisabled()
		#endif
	}

	fileprivate func urlEntry() -> some View {
		#if os(iOS)
		self.plainEntry().keyboardType(.URL)
		#else
		self.plainEntry()
		#endif
	}
}

private struct SaveRow: View {
	let model: ServerSettingsModel
	let block: ServerSettingsModel.Block
	let title: String
	let action: () async -> Void

	var body: some View {
		HStack {
			Button(title) { Task { await action() } }
				.disabled(model.busy != nil)
			Spacer()
			if model.busy == block {
				ProgressView()
			} else if model.saved.contains(block) {
				Label("Saved", systemImage: "checkmark")
					.font(.footnote)
					.foregroundStyle(.green)
			}
		}
	}
}

private struct BlockMessage: View {
	let model: ServerSettingsModel
	let block: ServerSettingsModel.Block

	var body: some View {
		if let message = model.messages[block] {
			Text(message)
				.font(.footnote)
				.foregroundStyle(.secondary)
		}
	}
}

private func optionalText(_ value: Binding<String?>) -> Binding<String> {
	Binding(get: { value.wrappedValue ?? "" }, set: { value.wrappedValue = $0 })
}

public struct ServerSpeechSection: View {
	@Bindable var model: ServerSettingsModel

	public init(model: ServerSettingsModel) {
		self.model = model
	}

	public var body: some View {
		Section {
			TextField("Speech URL (TTS)", text: optionalText($model.speech.ttsUrl))
				.urlEntry()
				.accessibilityIdentifier("serverSpeechTTS")
			TextField("Transcription URL (STT)", text: optionalText($model.speech.sttUrl))
				.urlEntry()
			if model.voices.isEmpty {
				TextField("Voice", text: optionalText($model.speech.voice))
					.plainEntry()
			} else {
				Picker("Voice", selection: optionalText($model.speech.voice)) {
					ForEach(model.voices, id: \.self) { Text($0).tag($0) }
				}
			}
			Button("Detect local speech server") { Task { await model.detectSpeech() } }
				.disabled(model.busy != nil)
				.accessibilityIdentifier("serverSpeechDetect")
			SaveRow(model: model, block: .speech, title: "Save speech servers") { await model.saveSpeech() }
			BlockMessage(model: model, block: .speech)
		} header: {
			Text("Voice mode speech servers")
		} footer: {
			Text("OpenAI-shaped endpoints the deck server proxies for voice mode. Detect looks for one on the deck server's machine.")
		}
	}
}

public struct ServerAutoCompactSection: View {
	@Bindable var model: ServerSettingsModel

	public init(model: ServerSettingsModel) {
		self.model = model
	}

	public var body: some View {
		Section {
			Toggle("Compact automatically", isOn: $model.autoCompact.enabled)
				.accessibilityIdentifier("serverAutoCompact")
			Stepper(
				"At \(model.autoCompact.percent)% of context",
				value: $model.autoCompact.percent,
				in: AutoCompactSettings.minPercent...AutoCompactSettings.maxPercent,
				step: 5)
				.disabled(!model.autoCompact.enabled)
			SaveRow(model: model, block: .autoCompact, title: "Save auto-compact") { await model.saveAutoCompact() }
			BlockMessage(model: model, block: .autoCompact)
		} header: {
			Text("Auto-compact")
		} footer: {
			Text("The deck server compacts a claude session once its context passes this share. Compacting is lossy, so it is off by default.")
		}
	}
}

public struct ServerOperatorSection: View {
	@Bindable var model: ServerSettingsModel

	public init(model: ServerSettingsModel) {
		self.model = model
	}

	public var body: some View {
		Section {
			TextField("Endpoint URL", text: $model.operatorURL)
				.urlEntry()
				.accessibilityIdentifier("serverOperatorURL")
			TextField("Model", text: $model.operatorModel)
				.plainEntry()
			Picker("Provider", selection: $model.operatorProvider) {
				Text("From the URL").tag(OperatorProvider?.none)
				ForEach(OperatorProvider.allCases, id: \.self) { Text($0.label).tag(OperatorProvider?.some($0)) }
			}
			TextField("Key file on the server (optional)", text: $model.operatorKeyFile)
				.plainEntry()
			keyRows
			SaveRow(model: model, block: .operator, title: "Save watch operator") { await model.saveOperator() }
			BlockMessage(model: model, block: .operator)
		} header: {
			Text("Watch operator model")
		} footer: {
			Text("The model the deck server thinks with for the Apple Watch operator. The phone uses its own on-device model. The stored key never leaves the server.")
		}
	}

	@ViewBuilder private var keyRows: some View {
		if model.hasApiKey && !model.replacingKey {
			LabeledContent("API key") {
				Text("A key is saved").foregroundStyle(.secondary)
			}
			.accessibilityIdentifier("serverOperatorKeySaved")
			Button("Replace key") { model.replacingKey = true }
				.disabled(model.busy != nil)
			Button("Remove key", role: .destructive) { Task { await model.removeApiKey() } }
				.disabled(model.busy != nil)
				.accessibilityIdentifier("serverOperatorKeyRemove")
		} else {
			SecureField(model.hasApiKey ? "New API key" : "API key (optional)", text: $model.newApiKey)
				.plainEntry()
				.accessibilityIdentifier("serverOperatorKey")
			if model.replacingKey {
				Button("Keep the saved key") {
					model.newApiKey = ""
					model.replacingKey = false
				}
			}
		}
	}
}

public struct ServerZedSection: View {
	@Bindable var model: ServerSettingsModel

	public init(model: ServerSettingsModel) {
		self.model = model
	}

	public var body: some View {
		Section {
			TextField("user@host[:port]", text: $model.zedSshTarget)
				.plainEntry()
				.accessibilityIdentifier("serverZedTarget")
			SaveRow(model: model, block: .zed, title: "Save Zed target") { await model.saveZed() }
			BlockMessage(model: model, block: .zed)
		} header: {
			Text("Open in Zed")
		} footer: {
			Text("The SSH target Zed connects to, when it differs from the host the app reaches deck on. Leave blank to use that host.")
		}
	}
}

public struct ServerSkillsSection: View {
	let model: ServerSettingsModel

	public init(model: ServerSettingsModel) {
		self.model = model
	}

	public var body: some View {
		Section {
			if model.skills.isEmpty && model.loaded {
				Text("No harnesses reported").foregroundStyle(.secondary)
			}
			ForEach(model.skills) { row in
				HStack {
					VStack(alignment: .leading, spacing: 2) {
						Text(row.kind).font(.body.monospaced())
						Text(row.summary)
							.font(.caption)
							.foregroundStyle(row.upToDate ? .green : .secondary)
					}
					Spacer()
					if model.installingSkill == row.kind {
						ProgressView()
					} else if row.canInstall {
						Button(row.installed ? "Update" : "Install") { Task { await model.install(kind: row.kind) } }
							.buttonStyle(.bordered)
							.disabled(model.installingSkill != nil)
							.accessibilityIdentifier("installSkill-\(row.kind)")
					}
				}
			}
			BlockMessage(model: model, block: .skills)
		} header: {
			Text("Agent skills")
		} footer: {
			Text("Installs the deck skill into each agent harness on the deck server, so its agents can drive deck.")
		}
	}
}

/// Every server settings section in order, for a Form of its own.
public struct ServerSettingsSections: View {
	let model: ServerSettingsModel

	public init(model: ServerSettingsModel) {
		self.model = model
	}

	public var body: some View {
		if let error = model.loadError {
			Section {
				Text(error).foregroundStyle(.red)
			}
		}
		ServerSpeechSection(model: model)
		ServerAutoCompactSection(model: model)
		ServerOperatorSection(model: model)
		ServerZedSection(model: model)
		ServerSkillsSection(model: model)
	}
}
