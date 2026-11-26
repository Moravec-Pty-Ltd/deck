import Foundation

/// A device asking for access (GET /api/agent/pairing). Approving it takes the
/// code that device shows, typed here. `code` is only sent by a deck from before
/// that, which leaves it to the person to compare.
public struct PairingRequest: Codable, Identifiable, Hashable, Sendable {
	public let id: String
	public let code: String

	public init(id: String, code: String = "") {
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

	/// Approve with the code typed, or deny with nil. False when the request had
	/// expired or was already decided.
	public func decidePairing(id: String, code: String?) async throws -> Bool {
		let path = "/api/agent/pairing/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)"
		let reply: PairingDecision = try await post(path, json: code.map { ["approve": true, "code": $0] } ?? ["approve": false])
		return reply.ok
	}
}
