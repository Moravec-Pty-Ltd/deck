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

	/// Whether the dev servers are on this machine, so the browser loads them
	/// directly with no tunnel. True when deck itself is reached over loopback:
	/// the machine deck runs on is the one its dev servers run on. Any other
	/// host, a tailnet name or a LAN address included, is another machine.
	public static func isDirect(deckOrigin: URL?) -> Bool {
		isLoopback(deckOrigin?.host)
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

	/// The SOCKS targets the tunnel carries. Deck only ever connects to its own
	/// loopback, so anything else would silently land on the wrong machine. The
	/// long IPv6 spelling is how the SOCKS handler writes out `::1`.
	public static func isTunnelTarget(_ host: String) -> Bool {
		let host = bare(host)
		return host == sentinel || all.contains(host) || host == "0000:0000:0000:0000:0000:0000:0000:0001"
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

/// Makes a tunnelled request reach the dev server as if the browser had used
/// `localhost`. The page really is `http://deck.localhost:<port>`, so WebKit
/// sends that as `Host`, `Origin` and `Referer`, and auth or CSRF checks that
/// compare against `http://localhost:<port>` refuse it ("invalid origin").
///
/// Only the first request head on a connection is rewritten. Every other
/// request gets `Connection: close`, so the browser opens a fresh connection,
/// with its own head, for the next one; that saves parsing bodies and chunked
/// encoding to find where a kept-alive connection's next request starts.
/// WebSocket upgrades (hot reload) keep their `Connection: Upgrade`.
struct RequestHeadRewriter {
	private var pending = Data()
	private var done = false

	init() {}

	/// The bytes to forward now: nothing while the head is still arriving, then
	/// the rewritten head plus whatever followed it, then everything as is.
	mutating func feed(_ bytes: Data) -> Data {
		guard !done else { return bytes }
		pending.append(bytes)
		guard let out = Self.rewrite(pending) else { return Data() }
		done = true
		pending = Data()
		return out
	}

	/// A head this long without its blank line is not a browser's.
	static let maxHead = 64 << 10

	/// The rewritten bytes, or nil while the head is incomplete. Anything that
	/// is not an HTTP/1 request (a TLS handshake for an https dev server) comes
	/// back unchanged.
	static func rewrite(_ data: Data) -> Data? {
		guard let first = data.first else { return nil }
		guard (UInt8(ascii: "A")...UInt8(ascii: "Z")).contains(first) else { return data }
		if let lineEnd = data.range(of: Data("\r\n".utf8)), !isRequestLine(data[..<lineEnd.lowerBound]) {
			return data
		}
		guard let end = data.range(of: Data("\r\n\r\n".utf8)) else {
			return data.count > maxHead ? data : nil
		}
		// Latin-1 maps every byte to one character and back, so header bytes that
		// are not ASCII survive untouched.
		let lines = latin1(data[..<end.lowerBound]).components(separatedBy: "\r\n")
		let upgrade = lines.contains { line in
			header(line).map { $0.name == "upgrade" && $0.value.lowercased().contains("websocket") } ?? false
		}
		let host = lines.lazy.compactMap(header).first { $0.name == "host" }?.value.lowercased()
		var out = [lines[0]]
		for line in lines.dropFirst() {
			guard let (name, value) = header(line) else { out.append(line); continue }
			let original = line[..<line.firstIndex(of: ":")!]
			switch name {
			case "host": out.append("\(original): \(unstand(value))")
			// A cross-origin request keeps the page's real origin: servers echo it
			// back as Access-Control-Allow-Origin, and WebKit checks that against
			// `deck.localhost`, so rewriting it would fail CORS.
			case "origin" where value.lowercased() == "http://\(host ?? "")":
				out.append("\(original): \(unstandURL(value))")
			case "referer": out.append("\(original): \(unstandURL(value))")
			case "connection" where !upgrade: continue
			default: out.append(line)
			}
		}
		if !upgrade { out.append("Connection: close") }
		var result = out.joined(separator: "\r\n").data(using: .isoLatin1)!
		result.append(data[end.lowerBound...])
		return result
	}

	private static func isRequestLine(_ bytes: Data) -> Bool {
		let parts = latin1(bytes).split(separator: " ", omittingEmptySubsequences: false)
		return parts.count == 3 && parts[0].allSatisfy { $0.isASCII && $0.isUppercase } && parts[2].hasPrefix("HTTP/1.")
	}

	private static func latin1(_ bytes: Data) -> String {
		String(data: bytes, encoding: .isoLatin1) ?? ""
	}

	private static func header(_ line: String) -> (name: String, value: String)? {
		guard let colon = line.firstIndex(of: ":") else { return nil }
		return (line[..<colon].lowercased(), line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces))
	}

	/// `deck.localhost[:port]...` to `localhost[:port]...`, and nothing else:
	/// `deck.localhostile` is a different host.
	private static func unstand(_ value: some StringProtocol) -> String {
		let sentinel = LoopbackHost.sentinel
		guard value.lowercased().hasPrefix(sentinel) else { return String(value) }
		let rest = value.dropFirst(sentinel.count)
		guard rest.first.map({ ":/?#".contains($0) }) ?? true else { return String(value) }
		return "localhost" + rest
	}

	private static func unstandURL(_ value: String) -> String {
		guard let scheme = value.range(of: "://") else { return value }
		return value[..<scheme.upperBound] + unstand(value[scheme.upperBound...])
	}
}
