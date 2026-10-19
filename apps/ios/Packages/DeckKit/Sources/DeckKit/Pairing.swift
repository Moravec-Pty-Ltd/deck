import Foundation

/// A device asking for access (GET /api/agent/pairing). Approve it only when
/// `code` matches the one that device shows.
public struct PairingRequest: Codable, Identifiable, Hashable, Sendable {
	public let id: String
	public let code: String

	public init(id: String, code: String) {
		self.id = id
		self.code = code
	}
}

struct PairingList: Codable, Sendable {
	let pending: [PairingRequest]
}

private struct PairingDecision: Codable, Sendable {
	let ok: Bool
}

extension DeckClient {
	public func pairingRequests() async throws -> [PairingRequest] {
		let list: PairingList = try await get("/api/agent/pairing")
		return list.pending
	}

	/// False when the request had expired or was already decided.
	public func decidePairing(id: String, approve: Bool) async throws -> Bool {
		let path = "/api/agent/pairing/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)"
		let reply: PairingDecision = try await post(path, json: ["approve": approve])
		return reply.ok
	}
}
