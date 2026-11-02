import Foundation

/// A session's Live Activity data: the attributes fixed when the card starts
/// and the `ContentState` deck pushes, key for key. Lives here, without
/// ActivityKit, so the server's push-to-start payload can be pinned by tests;
/// the app adds the `ActivityAttributes` conformance. The type name is part of
/// the contract: deck's start push names it in `attributes-type`.
public struct SessionActivityAttributes: Codable, Hashable, Sendable {
	public struct ContentState: Codable, Hashable, Sendable {
		public var status: String
		public var awaitingInput: Bool
		public var lastText: String
		public var costUsd: Double
		public var turns: Int
		public var updatedAt: Double

		public init(status: String, awaitingInput: Bool, lastText: String, costUsd: Double, turns: Int, updatedAt: Double) {
			self.status = status
			self.awaitingInput = awaitingInput
			self.lastText = lastText
			self.costUsd = costUsd
			self.turns = turns
			self.updatedAt = updatedAt
		}
	}

	public let sessionId: String
	public let title: String
	public let startedAt: Date

	public init(sessionId: String, title: String, startedAt: Date) {
		self.sessionId = sessionId
		self.title = title
		self.startedAt = startedAt
	}
}

public extension SessionGrouping {
	/// Whether a session's card belongs on the lock screen (issue #378), the
	/// rule deck's server applies in apns-core.ts: working, asking, an unread
	/// error, or gone quiet within the just-finished window.
	static func showsActivity(_ s: SessionDigest, now: Date = Date()) -> Bool {
		if s.isWorking || s.awaitingInput == true || (s.status == .error && s.unread == true) { return true }
		return now.timeIntervalSince1970 * 1000 - (s.lastActiveAt ?? 0) <= justFinishedWindow * 1000
	}
}
