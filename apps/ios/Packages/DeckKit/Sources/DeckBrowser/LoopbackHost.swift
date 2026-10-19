import Foundation

/// Address-bar rules for a browser whose loopback traffic belongs to another
/// machine. No WebKit, no sockets, so it is all unit-testable.
///
/// The problem this exists for: WKWebView refuses to send a literal `localhost`,
/// `127.0.0.1` or `::1` through a proxy. It bypasses them straight to the
/// device's own loopback, where nothing is listening. So a loopback URL is
/// rewritten to a sentinel host on the way in, and the SOCKS handler maps it
/// back on the far side, where loopback means the deck machine.
///
/// The sentinel is a `.localhost` subdomain on purpose. Dev servers that check
/// the Host header (Vite's `allowedHosts`) accept `localhost` and anything under
/// `.localhost` without configuration, so this passes the check while staying a
/// distinct host that WKWebView is willing to proxy.
public enum LoopbackHost {
	public static let sentinel = "deck.localhost"

	public static let all: Set<String> = ["localhost", "127.0.0.1", "::1"]

	public static func isLoopback(_ host: String?) -> Bool {
		guard let host else { return false }
		return all.contains(bare(host))
	}

	/// A host as it can be compared. `URLComponents` hands back an IPv6 literal
	/// with its brackets (`[::1]`), so comparing the raw value against `::1`
	/// silently never matches, and an IPv6 loopback URL leaks past the proxy to
	/// the device's own loopback.
	private static func bare(_ host: String) -> String {
		let lower = host.lowercased()
		guard lower.hasPrefix("["), lower.hasSuffix("]") else { return lower }
		return String(lower.dropFirst().dropLast())
	}

	/// What the SOCKS handler asks the far side to connect to.
	///
	/// Deliberately `localhost` rather than `127.0.0.1`: the far side resolves it
	/// and tries both `::1` and the IPv4 address. Dev servers commonly bind IPv6
	/// loopback only, and a hardcoded `127.0.0.1` gets connection refused there.
	public static func target(_ host: String) -> String {
		bare(host) == sentinel ? "localhost" : host
	}

	/// Turn address-bar text into a URL to load.
	///
	/// `tunnelled` says whether the proxy is up. When it is, a loopback host
	/// becomes the sentinel; when it is not, the text is left alone so the
	/// failure is the honest one (nothing listening here) rather than a
	/// confusing DNS error for a host that only means something through a proxy.
	public static func resolve(_ text: String, tunnelled: Bool) -> URL? {
		let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !trimmed.isEmpty else { return nil }
		guard var components = URLComponents(string: withScheme(trimmed)) else { return nil }
		if tunnelled, isLoopback(components.host) { components.host = sentinel }
		return components.url
	}

	/// Default the scheme, choosing http for a loopback host because a dev server
	/// is rarely on https, and https for anything else.
	private static func withScheme(_ text: String) -> String {
		guard !text.contains("://") else { return text }
		let host = bare(hostPart(text))
		return (all.contains(host) || host == sentinel ? "http://" : "https://") + text
	}

	/// The host out of scheme-less address-bar text: everything before the first
	/// slash, then before the port. An IPv6 literal is bracketed and full of
	/// colons, so it is taken whole rather than split on the first one.
	private static func hostPart(_ text: String) -> String {
		let authority = text.split(separator: "/").first.map(String.init) ?? ""
		if authority.hasPrefix("["), let close = authority.firstIndex(of: "]") {
			return String(authority[...close])
		}
		return authority.split(separator: ":").first.map(String.init) ?? ""
	}

	/// Show `localhost` in the address bar, never the sentinel. The sentinel is
	/// plumbing; typing it back in has to keep working, which `resolve` handles
	/// by treating it as already-http.
	public static func display(_ absolute: String) -> String {
		absolute.replacingOccurrences(of: sentinel, with: "localhost")
	}
}
