import DeckKit
import Network
import XCTest
@testable import DeckBrowser

/// The tunnel end to end: the loopback SOCKS5 listener, a WebSocket to a
/// running deck's `/api/tunnel`, and a request that comes back through both.
///
/// Needs a deck on this machine to talk to, so that test skips unless one is
/// configured, the same bargain the UI tests make:
///
///     DECK_TUNNEL_URL=http://127.0.0.1:4819 DECK_TUNNEL_TOKEN=test swift test
final class DevTunnelTests: XCTestCase {
	private var target: EchoingHTTPServer?

	override func tearDown() {
		target?.stop()
		target = nil
		super.tearDown()
	}

	@MainActor
	func testARequestReachesTheDeckMachinesLoopbackThroughTheTunnel() async throws {
		let env = ProcessInfo.processInfo.environment
		guard let url = env["DECK_TUNNEL_URL"].flatMap(URL.init(string:)), let token = env["DECK_TUNNEL_TOKEN"] else {
			throw XCTSkip("set DECK_TUNNEL_URL and DECK_TUNNEL_TOKEN to a running deck to run this")
		}

		// The thing we are trying to reach, standing in for a dev server. It is
		// on this machine because deck is too, which is what makes the round
		// trip checkable at all.
		let target = try EchoingHTTPServer(body: "tunnelled")
		self.target = target
		try target.start()

		let tunnel = DevTunnel()
		// Without this the test would pass on a bypassed proxy, since the target
		// is on this machine and reachable either way.
		var forwards: [(host: String, port: Int)] = []
		var refusals: [String] = []
		tunnel.onForward = { forwards.append((host: $0, port: $1)) }
		tunnel.onForwardError = { refusals.append($0) }

		await tunnel.start(.init(credentials: Credentials(baseURL: url, token: token)))
		guard case .connected(let localPort) = tunnel.status else {
			return XCTFail("listener did not come up: \(tunnel.status)")
		}

		// Through the sentinel on purpose: it has to be mapped back to
		// localhost, which is the whole point of the rewrite.
		let body = try await Self.get("http://\(LoopbackHost.sentinel):\(target.port)/", throughSOCKS: localPort)
		XCTAssertEqual(body, "tunnelled")
		XCTAssertEqual(forwards.map(\.host), ["localhost"])
		XCTAssertEqual(forwards.map(\.port), [Int(target.port)])
		XCTAssertEqual(refusals, [])

		await tunnel.stop()
	}

	/// Two starts landing together must not both try to bind the SOCKS port.
	///
	/// Opening the browser, a return to the foreground and a dropped listener
	/// can all fire at once. Before they were serialised, the second start
	/// found no listener to close (the first had not assigned one yet) and then
	/// failed to bind with EADDRINUSE, which is what shipped in build 38.
	@MainActor
	func testOverlappingStartsDoNotFightOverTheLocalPort() async throws {
		let probe = DevTunnel()
		await probe.start(Self.config())
		guard case .connected(let free) = probe.status else { return XCTFail("\(probe.status)") }
		await probe.stop()

		// A fixed port on purpose: two binds to 0 both succeed, so an ephemeral
		// one could not clash at all.
		let tunnel = DevTunnel()
		var states: [DevTunnel.Status] = []
		tunnel.onStatus = { states.append($0) }

		async let first: Void = tunnel.start(Self.config(localPort: free))
		async let second: Void = tunnel.start(Self.config(localPort: free))
		_ = await (first, second)

		XCTAssertFalse(states.contains { if case .failed = $0 { true } else { false } }, "\(states)")
		XCTAssertEqual(states.last, .connected(localPort: free))
		await tunnel.stop()
	}

	/// A rebind (signing in again changes the config) lands on the same port,
	/// which keeps the web views' proxy configuration valid, so no tab reloads.
	/// A start against a live listener with the same config changes nothing.
	@MainActor
	func testARebindKeepsThePort() async throws {
		let tunnel = DevTunnel()
		var states: [DevTunnel.Status] = []
		tunnel.onStatus = { states.append($0) }
		await tunnel.start(Self.config())
		let before = tunnel.status
		guard case .connected = before else { return XCTFail("\(before)") }
		await tunnel.start(Self.config())
		XCTAssertEqual(states, [.connecting, before], "a live listener is left alone")
		var signedInAgain = Self.config()
		signedInAgain.credentials = Credentials(baseURL: URL(string: "http://deck.invalid")!, token: "other")
		await tunnel.start(signedInAgain)
		XCTAssertEqual(tunnel.status, before)
		XCTAssertEqual(states.count, 3, "the new config rebinds")
		await tunnel.stop()
	}

	/// The route differs per session, so each gets its own listener, and
	/// leaving the browser and coming back reuses it rather than building a
	/// second one that could not bind the port.
	@MainActor
	func testBrowsersShareATunnelPerSession() {
		let credentials = Credentials(baseURL: URL(string: "https://example.ts.net:4818")!, token: "t")
		let first = BrowserModel(credentials: credentials)
		let second = BrowserModel(credentials: credentials)
		let scoped = BrowserModel(credentials: credentials, sessionId: "s1")
		XCTAssertTrue(first.tunnel === second.tunnel)
		XCTAssertTrue(first.tunnel === DevTunnel.shared(for: nil))
		XCTAssertTrue(scoped.tunnel === DevTunnel.shared(for: "s1"))
		XCTAssertFalse(scoped.tunnel === first.tunnel)
	}

	func testTheUpgradeCarriesThePortSessionAndToken() throws {
		let credentials = Credentials(baseURL: URL(string: "https://deck.example.ts.net")!, token: "secret")
		let scoped = try XCTUnwrap(DevTunnel.Config(credentials: credentials, sessionId: "s1").request(port: 5173))
		XCTAssertEqual(scoped.url?.absoluteString, "wss://deck.example.ts.net/api/tunnel?port=5173&session=s1")
		XCTAssertEqual(scoped.value(forHTTPHeaderField: "Authorization"), "Bearer secret")

		let local = Credentials(baseURL: URL(string: "http://192.168.1.20:4818")!, token: "t")
		let wide = try XCTUnwrap(DevTunnel.Config(credentials: local).request(port: 3000))
		XCTAssertEqual(wide.url?.absoluteString, "ws://192.168.1.20:4818/api/tunnel?port=3000")
	}

	// MARK: Harness

	private static func config(localPort: Int = 0) -> DevTunnel.Config {
		.init(credentials: Credentials(baseURL: URL(string: "http://deck.invalid")!, token: "t"), localPort: localPort)
	}

	/// A GET through a SOCKS5 proxy. URLSession does the handshake, so this
	/// exercises the listener the way WebKit will.
	private static func get(_ url: String, throughSOCKS port: Int) async throws -> String {
		let configuration = URLSessionConfiguration.ephemeral
		configuration.connectionProxyDictionary = [
			kCFStreamPropertySOCKSProxyHost as String: "127.0.0.1",
			kCFStreamPropertySOCKSProxyPort as String: port,
			kCFStreamPropertySOCKSVersion as String: kCFStreamSocketSOCKSVersion5
		]
		configuration.timeoutIntervalForRequest = 20
		let session = URLSession(configuration: configuration)
		let (data, _) = try await session.data(from: URL(string: url)!)
		return String(decoding: data, as: UTF8.self)
	}
}

/// The smallest thing that answers an HTTP request, on an ephemeral port.
private final class EchoingHTTPServer: @unchecked Sendable {
	private let listener: NWListener
	private let queue = DispatchQueue(label: "tunnel-test-target")
	private let body: String
	private(set) var port: UInt16 = 0

	init(body: String) throws {
		self.body = body
		listener = try NWListener(using: .tcp, on: .any)
	}

	func start() throws {
		let ready = DispatchSemaphore(value: 0)
		listener.stateUpdateHandler = { if case .ready = $0 { ready.signal() } }
		listener.newConnectionHandler = { [weak self] connection in
			guard let self else { return }
			connection.start(queue: self.queue)
			self.answer(connection)
		}
		listener.start(queue: queue)
		guard ready.wait(timeout: .now() + 5) == .success, let bound = listener.port?.rawValue else {
			throw NSError(domain: "EchoingHTTPServer", code: 1)
		}
		port = bound
	}

	func stop() { listener.cancel() }

	private func answer(_ connection: NWConnection) {
		connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] _, _, _, _ in
			guard let self else { return }
			let response = """
				HTTP/1.1 200 OK\r
				Content-Type: text/plain\r
				Content-Length: \(self.body.utf8.count)\r
				Connection: close\r
				\r
				\(self.body)
				"""
			connection.send(
				content: Data(response.utf8),
				completion: .contentProcessed { _ in connection.cancel() })
		}
	}
}
