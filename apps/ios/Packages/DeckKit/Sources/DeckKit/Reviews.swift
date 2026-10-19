import Foundation

/// The PR reviewer's state as deck last saw it (GET /api/agent/reviews).
public struct ReviewsSnapshot: Codable, Equatable, Sendable {
	public enum Status: String, Codable, Sendable {
		case ok, offline, unconfigured
	}

	public let status: Status
	public let updatedAt: String?
	public let inFlight: InFlightReview?
	public let recent: [RecentReview]
	public let recentErrors: [ReviewError]

	public init(status: Status, updatedAt: String? = nil, inFlight: InFlightReview? = nil, recent: [RecentReview] = [], recentErrors: [ReviewError] = []) {
		self.status = status
		self.updatedAt = updatedAt
		self.inFlight = inFlight
		self.recent = recent
		self.recentErrors = recentErrors
	}

	/// Unconfigured hides the whole panel, as the web sidebar does.
	public var isShown: Bool { status != .unconfigured }
}

public struct InFlightReview: Codable, Equatable, Sendable {
	public let repo: String
	public let pr: Int
	public let headSha: String
	public let phase: String
	public let startedAt: String

	public var phaseLabel: String {
		switch phase {
		case "context": return "Gathering context"
		case "model": return "Reviewing"
		default: return "Posting"
		}
	}
}

public struct RecentReview: Codable, Equatable, Identifiable, Sendable {
	public let repo: String
	public let pr: Int
	public let headSha: String
	public let decision: String
	public let reviewId: Int
	public let url: String
	public let reviewedAt: String

	public var id: Int { reviewId }

	public var decisionLabel: String {
		switch decision {
		case "APPROVE": return "Approved"
		case "REQUEST_CHANGES": return "Changes requested"
		default: return "Commented"
		}
	}
}

public struct ReviewError: Codable, Equatable, Identifiable, Sendable {
	public let repo: String
	public let pr: Int
	public let headSha: String
	public let phase: String
	public let message: String
	public let url: String
	public let failedAt: String

	public var id: String { failedAt + "\(pr)" + phase }

	/// `failedAt` as epoch milliseconds, for RelativeFormat.
	public var failedAtMs: Double? {
		let plain = ISO8601DateFormatter()
		let fractional = ISO8601DateFormatter()
		fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
		let date = fractional.date(from: failedAt) ?? plain.date(from: failedAt)
		return date.map { $0.timeIntervalSince1970 * 1000 }
	}

	public var phaseLabel: String {
		switch phase {
		case "context": return "Context"
		case "model": return "Model"
		case "posting": return "Posting"
		default: return "Preparation"
		}
	}
}

public enum ReviewMatch {
	/// The first session that captured this repo#pr, so a review opens it rather
	/// than leaving the app (the web sidebar's matchSessionForReview).
	public static func session(repo: String, pr: Int, in sessions: [SessionDigest]) -> SessionDigest? {
		sessions.first { $0.pr?.repo == repo && $0.pr?.number == pr }
	}
}

extension DeckClient {
	public func reviews() async throws -> ReviewsSnapshot {
		try await get("/api/agent/reviews")
	}
}
