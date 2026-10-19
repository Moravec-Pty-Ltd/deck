import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// What POST /api/pair/request hands a new device: the secret it polls with
/// and the code to compare against the one deck shows the approver.
public struct PairingTicket: Decodable, Equatable, Sendable {
	public let secret: String
	public let code: String
	/// Milliseconds since the epoch, as the server sends it.
	public let expiresAt: Double

	public init(secret: String, code: String, expiresAt: Double) {
		self.secret = secret
		self.code = code
		self.expiresAt = expiresAt
	}

	public var expiry: Date { Date(timeIntervalSince1970: expiresAt / 1000) }

	/// The longest a client waits for approval before giving up.
	public static let pollLimit: TimeInterval = 5 * 60

	/// When to stop polling a request made at `start`: the ticket's own expiry,
	/// or five minutes on, whichever is sooner.
	public func pollDeadline(from start: Date) -> Date {
		min(expiry, start.addingTimeInterval(Self.pollLimit))
	}
}

/// One poll of GET /api/pair/status.
public enum PairingClaim: Equatable, Sendable {
	case pending
	case approved(token: String)
	case denied
	case expired
	/// The server forgot the request, or approved it without handing over a
	/// token this client could read.
	case unknown
}

/// Asks a deck server for access the way a browser on a new device does, so
/// a machine without a camera can sign in without anyone copying the token.
/// The server answers an approved poll by setting the auth cookie, never in
/// the body, so the token is read from that cookie.
public struct PairingClient: Sendable {
	public let baseURL: URL
	private let session: URLSession

	static let cookieName = "deck_token"

	public init(baseURL: URL) {
		self.baseURL = baseURL
		let config = URLSessionConfiguration.ephemeral
		config.timeoutIntervalForRequest = 15
		self.session = URLSession(configuration: config)
	}

	public func request() async throws -> PairingTicket {
		var request = URLRequest(url: baseURL.appendingPathComponent("api/pair/request"))
		request.httpMethod = "POST"
		let (data, response) = try await session.data(for: request)
		try Self.check(response)
		return try JSONDecoder().decode(PairingTicket.self, from: data)
	}

	public func status(secret: String) async throws -> PairingClaim {
		var components = URLComponents(url: baseURL.appendingPathComponent("api/pair/status"), resolvingAgainstBaseURL: false)
		components?.queryItems = [URLQueryItem(name: "secret", value: secret)]
		guard let url = components?.url else { throw URLError(.badURL) }
		let (data, response) = try await session.data(from: url)
		try Self.check(response)
		let status = (try? JSONDecoder().decode([String: String].self, from: data))?["status"]
		let headers = (response as? HTTPURLResponse)?.allHeaderFields ?? [:]
		return Self.claim(status: status, headers: headers, url: url)
	}

	static func claim(status: String?, headers: [AnyHashable: Any], url: URL) -> PairingClaim {
		switch status {
		case "pending": return .pending
		case "denied": return .denied
		case "expired": return .expired
		case "approved":
			guard let token = token(fromHeaders: headers, url: url) else { return .unknown }
			return .approved(token: token)
		default: return .unknown
		}
	}

	static func token(fromHeaders headers: [AnyHashable: Any], url: URL) -> String? {
		var fields: [String: String] = [:]
		for (key, value) in headers {
			if let key = key as? String, let value = value as? String { fields[key] = value }
		}
		let cookie = HTTPCookie.cookies(withResponseHeaderFields: fields, for: url)
			.first { $0.name == cookieName }
		guard let value = cookie?.value, !value.isEmpty else { return nil }
		return value
	}

	private static func check(_ response: URLResponse) throws {
		guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
		guard (200..<300).contains(http.statusCode) else { throw URLError(.badServerResponse) }
	}
}
