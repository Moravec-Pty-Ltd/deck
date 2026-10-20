import Foundation

// Voice mode's server contract: what deck can do (GET /api/agent/speech), the
// sentence segments a reply becomes (POST /api/agent/speech/segments) and their
// audio (GET /api/agent/speech/audio/{id}), and push-to-talk transcription
// (POST /api/agent/speech/transcribe). deck proxies a speech server it is configured
// with; a client only ever talks to deck.

public struct SpeechCapabilities: Codable, Hashable, Sendable {
	public let tts: Bool
	public let stt: Bool
	public let voice: String?
	public let voices: [String]?

	public init(tts: Bool, stt: Bool, voice: String? = nil, voices: [String]? = nil) {
		self.tts = tts
		self.stt = stt
		self.voice = voice
		self.voices = voices
	}
}

public struct SpeechSegment: Codable, Hashable, Identifiable, Sendable {
	public let id: String
	public let text: String

	public init(id: String, text: String) {
		self.id = id
		self.text = text
	}
}

public struct Transcription: Codable, Hashable, Sendable {
	public let text: String
	public let seconds: Double?
}

extension DeckClient {
	public func speechCapabilities() async throws -> SpeechCapabilities {
		try await get("/api/agent/speech")
	}

	/// The sentence segments a reply is read as; audio comes per segment so
	/// the first plays while the rest is still being made.
	public func speechSegments(text: String) async throws -> [SpeechSegment] {
		struct Body: Decodable { let segments: [SpeechSegment] }
		let response: Body = try await post("/api/agent/speech/segments", json: ["text": text])
		return response.segments
	}

	/// One segment's audio (WAV), synthesised on first request and cached.
	public func speechAudio(id: String) async throws -> Data {
		try await getData("/api/agent/speech/audio/\(id)")
	}

	/// A recording (any container deck's speech server reads) to text. Empty
	/// text means silence.
	public func transcribe(audio: Data, mimeType: String) async throws -> Transcription {
		try await upload("/api/agent/speech/transcribe", body: audio, contentType: mimeType)
	}
}

// MARK: - Transcript search

public struct SearchHit: Codable, Hashable, Identifiable, Sendable {
	public var id: String { "\(sessionId):\(index)" }
	public let sessionId: String
	public let title: String
	/// Absolute event index on the session's transcript, for opening at it.
	public let index: Int
	public let role: String
	public let snippet: String
	public let at: Double?
}

public struct SearchResponse: Codable, Sendable {
	public let query: String
	public let hits: [SearchHit]
	public let truncated: Bool?
}

extension DeckClient {
	/// Everything said (by you or the agent) across sessions that contains
	/// `query`, newest sessions first.
	public func search(query: String, limit: Int = 40) async throws -> SearchResponse {
		try await get("/api/agent/search", query: [
			URLQueryItem(name: "q", value: query),
			URLQueryItem(name: "limit", value: String(limit))
		])
	}
}

// MARK: - Live Activity tokens

extension DeckClient {
	/// Tell deck a Live Activity for a session exists, so it pushes updates to
	/// the card while the app is suspended.
	public func registerActivity(sessionId: String, token: String, env: String) async throws {
		_ = try await postRaw("/api/push/apns/activity", json: ["sessionId": sessionId, "token": token, "env": env])
	}

	public func unregisterActivity(token: String) async throws {
		_ = try await requestData("DELETE", "/api/push/apns/activity", body: ["token": token])
	}
}
