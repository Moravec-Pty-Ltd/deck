import Foundation
import Observation

// The deck server's own settings (GET/PATCH /api/agent/settings): its
// ~/.deck/settings.json, shared by every client, as opposed to what the app
// keeps on this device. The server never sends a secret back: the operator key
// reads only as `hasApiKey`, a model profile's env only as its variable names.

public struct SpeechServerSettings: Codable, Equatable, Sendable {
	public var ttsUrl: String?
	public var sttUrl: String?
	/// A WebSocket for live transcription, which lets a take end on the words.
	public var streamUrl: String?
	public var voice: String?

	public init(ttsUrl: String? = nil, sttUrl: String? = nil, streamUrl: String? = nil, voice: String? = nil) {
		self.ttsUrl = ttsUrl
		self.sttUrl = sttUrl
		self.streamUrl = streamUrl
		self.voice = voice
	}
}

public enum OperatorProvider: String, Codable, CaseIterable, Sendable {
	case openai
	case anthropic

	public var label: String {
		switch self {
		case .openai: return "OpenAI-compatible"
		case .anthropic: return "Anthropic"
		}
	}
}

public struct OperatorServerSettings: Codable, Equatable, Sendable {
	public var url: String?
	public var model: String?
	/// Absent means the server reads it from the URL.
	public var provider: OperatorProvider?
	public var apiKeyFile: String?
	public var hasApiKey: Bool

	public init(url: String? = nil, model: String? = nil, provider: OperatorProvider? = nil, apiKeyFile: String? = nil, hasApiKey: Bool = false) {
		self.url = url
		self.model = model
		self.provider = provider
		self.apiKeyFile = apiKeyFile
		self.hasApiKey = hasApiKey
	}

	public init(from decoder: Decoder) throws {
		let c = try decoder.container(keyedBy: CodingKeys.self)
		url = try c.decodeIfPresent(String.self, forKey: .url)
		model = try c.decodeIfPresent(String.self, forKey: .model)
		provider = (try? c.decodeIfPresent(String.self, forKey: .provider)).flatMap { $0.flatMap(OperatorProvider.init(rawValue:)) }
		apiKeyFile = try c.decodeIfPresent(String.self, forKey: .apiKeyFile)
		hasApiKey = try c.decodeIfPresent(Bool.self, forKey: .hasApiKey) ?? false
	}
}

public struct AutoCompactSettings: Codable, Equatable, Sendable {
	public static let minPercent = 50
	public static let maxPercent = 95
	public static let defaultPercent = 80

	public var enabled: Bool
	public var percent: Int

	public init(enabled: Bool = false, percent: Int = AutoCompactSettings.defaultPercent) {
		self.enabled = enabled
		self.percent = Self.clamp(percent)
	}

	/// The server's clampCompactPercent: 50...95.
	public static func clamp(_ percent: Int) -> Int {
		min(maxPercent, max(minPercent, percent))
	}
}

public struct ModelProfileSummary: Codable, Equatable, Sendable {
	public let id: String
	public let label: String?
	public let model: String?
	public let envKeys: [String]
}

/// GET /api/agent/settings. Each block is absent when unset.
public struct ServerSettings: Codable, Equatable, Sendable {
	public var speech: SpeechServerSettings?
	public var `operator`: OperatorServerSettings?
	public var autoCompact: AutoCompactSettings?
	public var zedSshTarget: String?
	public var modelProfiles: [ModelProfileSummary]?

	public init(
		speech: SpeechServerSettings? = nil,
		operator: OperatorServerSettings? = nil,
		autoCompact: AutoCompactSettings? = nil,
		zedSshTarget: String? = nil,
		modelProfiles: [ModelProfileSummary]? = nil
	) {
		self.speech = speech
		self.operator = `operator`
		self.autoCompact = autoCompact
		self.zedSshTarget = zedSshTarget
		self.modelProfiles = modelProfiles
	}
}

/// POST /api/agent/settings/speech/detect. Nothing is saved by detecting.
public struct SpeechDetection: Codable, Equatable, Sendable {
	public let found: Bool
	public let url: String?
	public let voices: [String]?
	public let voice: String?
	public let stt: Bool?
}

/// One harness's row from GET /api/agent/settings/skill.
public struct SkillInstallStatus: Codable, Equatable, Identifiable, Sendable {
	public let kind: String
	public let available: Bool
	public let supported: Bool
	public let installed: Bool
	public let installedVersion: String?
	public let shippedVersion: String?
	public let upToDate: Bool

	public var id: String { kind }

	public var canInstall: Bool { available && supported && !upToDate }

	public var summary: String {
		if !available { return "Not installed on the server" }
		if !supported { return "No known skill directory" }
		if upToDate { return "v\(installedVersion ?? "?") installed" }
		if installed { return "v\(installedVersion ?? "?") installed, v\(shippedVersion ?? "?") available" }
		return "Skill not installed"
	}
}

/// What to do with the operator's stored key. The app never holds the stored
/// value, so "keep" is sent as no `apiKey` field at all.
public enum OperatorKeyChange: Equatable, Sendable {
	case keep
	case replace(String)
	case remove
}

/// One block of a PATCH /api/agent/settings. Each save sends exactly one, so
/// a save in one section never overwrites another client's edit to a different
/// block. Blank strings clear a field on the server.
public enum ServerSettingsPatch: Equatable, Sendable {
	case speech(SpeechServerSettings)
	case `operator`(url: String, model: String, provider: OperatorProvider?, apiKeyFile: String, key: OperatorKeyChange)
	case autoCompact(AutoCompactSettings)
	case zedSshTarget(String)

	public var json: [String: Any] {
		switch self {
		case .speech(let s):
			return ["speech": [
				"ttsUrl": Self.trim(s.ttsUrl), "sttUrl": Self.trim(s.sttUrl), "streamUrl": Self.trim(s.streamUrl), "voice": Self.trim(s.voice)
			]]
		case .operator(let url, let model, let provider, let apiKeyFile, let key):
			var block: [String: Any] = [
				"url": Self.trim(url),
				"model": Self.trim(model),
				"provider": provider?.rawValue ?? NSNull(),
				"apiKeyFile": Self.trim(apiKeyFile)
			]
			switch key {
			case .keep: break
			case .replace(let value): block["apiKey"] = Self.trim(value)
			case .remove: block["apiKey"] = NSNull()
			}
			return ["operator": block]
		case .autoCompact(let a):
			return ["autoCompact": ["enabled": a.enabled, "percent": AutoCompactSettings.clamp(a.percent)]]
		case .zedSshTarget(let target):
			let trimmed = Self.trim(target)
			return ["zedSshTarget": trimmed.isEmpty ? NSNull() : trimmed]
		}
	}

	private static func trim(_ s: String?) -> String {
		(s ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
	}
}

extension DeckClient {
	public func serverSettings() async throws -> ServerSettings {
		try await get("/api/agent/settings")
	}

	/// Returns the settings as they stand after the merge, redacted as GET.
	@discardableResult
	public func patchServerSettings(_ patch: ServerSettingsPatch) async throws -> ServerSettings {
		let data = try await requestData("PATCH", "/api/agent/settings", body: patch.json)
		return try JSONDecoder().decode(ServerSettings.self, from: data)
	}

	public func detectSpeechServer() async throws -> SpeechDetection {
		try await post("/api/agent/settings/speech/detect", json: [:])
	}

	public func skillStatuses() async throws -> [SkillInstallStatus] {
		try await get("/api/agent/settings/skill")
	}

	@discardableResult
	public func installSkill(kind: String) async throws -> SkillInstallStatus {
		try await post("/api/agent/settings/skill", json: ["kind": kind])
	}
}

/// The editable copy of the server's settings behind the server settings
/// screens (iOS Settings, and the Mac Settings scene). Each block has its own
/// draft and save, and a save refreshes only its own block's draft so unsaved
/// edits in another section survive it.
@MainActor
@Observable
public final class ServerSettingsModel {
	public enum Block: Hashable, Sendable {
		case speech, `operator`, autoCompact, zed, skills
	}

	public var speech = SpeechServerSettings()
	public var voices: [String] = []
	public var operatorURL = ""
	public var operatorModel = ""
	public var operatorProvider: OperatorProvider?
	public var operatorKeyFile = ""
	public private(set) var hasApiKey = false
	/// A new key being typed. Sent only when non-blank, and never filled from the server.
	public var newApiKey = ""
	public var replacingKey = false
	public var autoCompact = AutoCompactSettings()
	public var zedSshTarget = ""
	public private(set) var skills: [SkillInstallStatus] = []

	public private(set) var loaded = false
	public private(set) var loadError: String?
	public private(set) var busy: Block?
	public private(set) var installingSkill: String?
	public private(set) var messages: [Block: String] = [:]
	public private(set) var saved: Set<Block> = []

	private let client: DeckClient

	public init(client: DeckClient) {
		self.client = client
	}

	public func load() async {
		do {
			let settings = try await client.serverSettings()
			apply(settings, to: [.speech, .operator, .autoCompact, .zed])
			loadError = nil
		} catch {
			loadError = error.localizedDescription
		}
		await loadSkills()
		loaded = true
	}

	public func loadSkills() async {
		do {
			skills = try await client.skillStatuses()
		} catch {
			messages[.skills] = error.localizedDescription
		}
	}

	public func saveSpeech() async {
		await save(.speech, .speech(speech))
	}

	public func saveOperator() async {
		let typed = newApiKey.trimmingCharacters(in: .whitespacesAndNewlines)
		await saveOperator(key: typed.isEmpty ? .keep : .replace(typed))
	}

	public func removeApiKey() async {
		await saveOperator(key: .remove)
	}

	public func saveAutoCompact() async {
		await save(.autoCompact, .autoCompact(autoCompact))
	}

	public func saveZed() async {
		await save(.zed, .zedSshTarget(zedSshTarget))
	}

	public func detectSpeech() async {
		busy = .speech
		saved.remove(.speech)
		defer { busy = nil }
		do {
			let found = try await client.detectSpeechServer()
			guard found.found, let url = found.url else {
				messages[.speech] = "No speech server answered on the deck server."
				return
			}
			speech.ttsUrl = url
			if found.stt == true { speech.sttUrl = url }
			voices = found.voices ?? []
			if speech.voice.map({ !voices.contains($0) }) ?? true {
				speech.voice = found.voice ?? voices.first
			}
			messages[.speech] = "Found a speech server (\(voices.count) voice\(voices.count == 1 ? "" : "s")). Save to use it."
		} catch {
			messages[.speech] = error.localizedDescription
		}
	}

	public func install(kind: String) async {
		installingSkill = kind
		defer { installingSkill = nil }
		do {
			let row = try await client.installSkill(kind: kind)
			skills = skills.map { $0.kind == row.kind ? row : $0 }
			messages[.skills] = nil
		} catch {
			messages[.skills] = error.localizedDescription
		}
	}

	private func saveOperator(key: OperatorKeyChange) async {
		await save(.operator, .operator(
			url: operatorURL, model: operatorModel, provider: operatorProvider,
			apiKeyFile: operatorKeyFile, key: key))
	}

	private func save(_ block: Block, _ patch: ServerSettingsPatch) async {
		busy = block
		saved.remove(block)
		messages[block] = nil
		defer { busy = nil }
		do {
			let settings = try await client.patchServerSettings(patch)
			apply(settings, to: [block])
			saved.insert(block)
		} catch {
			messages[block] = error.localizedDescription
		}
	}

	private func apply(_ s: ServerSettings, to blocks: Set<Block>) {
		if blocks.contains(.speech) { speech = s.speech ?? SpeechServerSettings() }
		if blocks.contains(.operator) {
			let op = s.operator ?? OperatorServerSettings()
			operatorURL = op.url ?? ""
			operatorModel = op.model ?? ""
			operatorProvider = op.provider
			operatorKeyFile = op.apiKeyFile ?? ""
			hasApiKey = op.hasApiKey
			newApiKey = ""
			replacingKey = false
		}
		if blocks.contains(.autoCompact) { autoCompact = s.autoCompact ?? AutoCompactSettings() }
		if blocks.contains(.zed) { zedSshTarget = s.zedSshTarget ?? "" }
	}
}
