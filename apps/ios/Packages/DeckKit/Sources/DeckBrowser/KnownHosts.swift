import CryptoKit
import Foundation

/// Trust on first use for the deck machine's SSH host key.
///
/// The prototype this tunnel comes from accepted any host key, which is fine
/// against a throwaway test server and not fine in a shipping app: anything that
/// can answer on that host and port could read every request. So the first
/// connection records the key and every later one has to match.
///
/// A mismatch fails the connection and says so. There is deliberately no
/// "accept anyway" button: the honest cases are that you rebuilt the machine or
/// changed its key, both of which you can fix by forgetting the host, and the
/// dishonest case should not be one tap away.
/// Read from the SSH event loop by the host-key delegate, so it has to cross
/// threads. Safe because the only state is a `UserDefaults` reference, which
/// Apple documents as thread-safe.
public struct KnownHosts: @unchecked Sendable {
	public enum Verdict: Equatable, Sendable {
		/// Matches the key recorded for this host.
		case trusted
		/// Nothing recorded before. Now it is.
		case learned
		/// A different key than last time. The connection must fail.
		case changed(expected: String, got: String)
	}

	static let defaultsKey = "deck.browser.knownHosts"

	private let defaults: UserDefaults

	public init(defaults: UserDefaults = .standard) {
		self.defaults = defaults
	}

	/// OpenSSH's fingerprint spelling, so a mismatch can be compared by eye
	/// against `ssh-keygen -lf` on the machine itself.
	public static func fingerprint(ofOpenSSHKey key: String) -> String {
		let digest = SHA256.hash(data: Data(key.utf8))
		let base64 = Data(digest).base64EncodedString().replacingOccurrences(of: "=", with: "")
		return "SHA256:\(base64)"
	}

	public func verify(host: String, port: Int, fingerprint: String) -> Verdict {
		var stored = all()
		let id = Self.id(host: host, port: port)
		guard let known = stored[id] else {
			stored[id] = fingerprint
			defaults.set(stored, forKey: Self.defaultsKey)
			return .learned
		}
		return known == fingerprint ? .trusted : .changed(expected: known, got: fingerprint)
	}

	/// Drop a host so the next connection learns its key again. The way out of a
	/// mismatch you know the reason for.
	public func forget(host: String, port: Int) {
		var stored = all()
		stored[Self.id(host: host, port: port)] = nil
		defaults.set(stored, forKey: Self.defaultsKey)
	}

	public func fingerprint(host: String, port: Int) -> String? {
		all()[Self.id(host: host, port: port)]
	}

	private func all() -> [String: String] {
		defaults.dictionary(forKey: Self.defaultsKey) as? [String: String] ?? [:]
	}

	/// The port belongs in the key: the same machine on another port is a
	/// different endpoint, and OpenSSH's own known_hosts records it the same way.
	private static func id(host: String, port: Int) -> String {
		"\(host.lowercased()):\(port)"
	}
}
