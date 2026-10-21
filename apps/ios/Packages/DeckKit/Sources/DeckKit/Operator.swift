import Foundation

// deck's server-side voice operator (`/api/agent/operator`): deck runs the model and
// drives the sessions, and the client just sends text and speaks the reply.
//
// The phone no longer uses this; it thinks with Apple's on-device model (see
// OperatorBrain). Only the watch still calls it, because watchOS ships
// FoundationModels but marks SystemLanguageModel unavailable, so a watch cannot
// think for itself however new it is. Everything here goes the day that
// changes, or the day the watch relays through the phone instead.

public struct OperatorAction: Codable, Sendable {
	public let tool: String
	public let result: String
}

public struct OperatorReply: Codable, Sendable {
	public let text: String
	public let actions: [OperatorAction]
}

public struct OperatorTurn: Codable, Sendable, Identifiable {
	public var id: String { "\(role)-\(at)-\(content.hashValue)" }
	public let role: String
	public let content: String
	public let at: Double
}

public struct OperatorStatus: Codable, Sendable {
	public let configured: Bool
	public let model: String?
}

public struct OperatorAnnouncement: Codable, Sendable {
	public let text: String
	public let sessionId: String
	public let kind: String
	public let at: Double
}

extension DeckClient {
	public func operatorStatus() async throws -> OperatorStatus {
		try await get("/api/agent/operator")
	}

	public func operatorSend(_ text: String, source: String = "ios") async throws -> OperatorReply {
		try await post("/api/agent/operator", json: ["text": text, "source": source])
	}

	public func operatorHistory(limit: Int = 60) async throws -> [OperatorTurn] {
		struct Reply: Decodable { let turns: [OperatorTurn] }
		let reply: Reply = try await get("/api/agent/operator/history", query: [URLQueryItem(name: "limit", value: String(limit))])
		return reply.turns
	}

	public func operatorReset() async throws {
		_ = try await requestData("POST", "/api/agent/operator/reset")
	}

	/// What the operator says on its own, for as long as the stream is held
	/// open. Ends or throws when the connection drops; the caller reconnects.
	public func operatorAnnouncements() -> AsyncThrowingStream<OperatorAnnouncement, Error> {
		serverEvents(path: "/api/agent/operator/events") { name, data in
			guard name == "announcement", let bytes = data.data(using: .utf8) else { return nil }
			return try? JSONDecoder().decode(OperatorAnnouncement.self, from: bytes)
		}
	}
}
