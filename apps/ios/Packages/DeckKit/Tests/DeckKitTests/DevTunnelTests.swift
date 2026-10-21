import Network
import XCTest
@testable import DeckBrowser

/// The tunnel end to end: a real SSH connection, the loopback SOCKS5 listener,
/// and a request that comes back through both.
///
/// Needs an SSH server to talk to, so it skips unless one is configured, the
/// same bargain the UI tests make with a running deck:
///
///     DECK_TUNNEL_HOST=127.0.0.1 DECK_TUNNEL_PORT=2222 \
///     DECK_TUNNEL_USER=dev DECK_TUNNEL_PASSWORD=devpass swift test
///
/// The server needs password auth and TCP forwarding allowed. Anything will do;
/// it only has to open a direct-tcpip channel to its own loopback.
final class DevTunnelTests: XCTestCase {
	private var target: EchoingHTTPServer?

	override func tearDown() {
		target?.stop()
		target = nil
		super.tearDown()
	}

	@MainActor
	func testARequestReachesTheFarSidesLoopbackThroughTheTunnel() async throws {
		guard let config = Self.configured() else {
			throw XCTSkip("set DECK_TUNNEL_HOST, DECK_TUNNEL_USER and DECK_TUNNEL_PASSWORD to run this")
		}

		// The thing we are trying to reach, standing in for a dev server. It is
		// on this machine because the SSH server is too, which is what makes the
		// round trip checkable at all.
		let target = try EchoingHTTPServer(body: "tunnelled")
		self.target = target
		try target.start()

		// A throwaway trust store: a test SSH server usually generates a fresh
		// host key per run, which a shared store would refuse the second time.
		let suite = "deck.browser.tests.\(UUID().uuidString)"
		let defaults = UserDefaults(suiteName: suite)!
		let tunnel = DevTunnel(knownHosts: KnownHosts(defaults: defaults))
		defer {
			defaults.removePersistentDomain(forName: suite)
		}

		var states: [DevTunnel.Status] = []
		let up = expectation(description: "tunnel up")
		tunnel.onStatus = { state in
			states.append(state)
			if case .connected = state { up.fulfill() }
			if case .failed = state { up.fulfill() }
		}
		// Without this the test would pass on a bypassed proxy, since the target
		// is on this machine and reachable either way.
		var forwards: [(host: String, port: Int)] = []
		tunnel.onForward = { forwards.append((host: $0, port: $1)) }

		await tunnel.start(config)
		await fulfillment(of: [up], timeout: 30)

		guard case .connected(let localPort) = states.last else {
			return XCTFail("tunnel did not come up: \(states)")
		}

		// Through the sentinel on purpose: the far side has to map it back to
		// localhost, which is the whole point of the rewrite.
		let body = try await Self.get(
			"http://\(LoopbackHost.sentinel):\(target.port)/",
			throughSOCKS: localPort)
		XCTAssertEqual(body, "tunnelled")

		// The request went through the tunnel, and the far side was asked for
		// "localhost" rather than the sentinel, which is what makes a dev server
		// bound to ::1 only reachable.
		XCTAssertEqual(forwards.map(\.host), ["localhost"])
		XCTAssertEqual(forwards.map(\.port), [Int(target.port)])

		await tunnel.stop()
	}

	/// Two starts landing together must not both try to bind the SOCKS port.
	///
	/// Auto-connect on open, a tap on Connect, a return to the foreground and a
	/// backoff retry can all fire at once. Before they were serialised, the
	/// second start found no listener to close (the first had not assigned one
	/// yet) and then failed to bind with EADDRINUSE, which is what shipped in
	/// build 38.
	@MainActor
	func testOverlappingStartsDoNotFightOverTheLocalPort() async throws {
		guard let config = Self.configured() else {
			throw XCTSkip("set DECK_TUNNEL_HOST, DECK_TUNNEL_USER and DECK_TUNNEL_PASSWORD to run this")
		}

		let suite = "deck.browser.tests.\(UUID().uuidString)"
		let defaults = UserDefaults(suiteName: suite)!
		defer { defaults.removePersistentDomain(forName: suite) }
		let tunnel = DevTunnel(knownHosts: KnownHosts(defaults: defaults))

		var states: [DevTunnel.Status] = []
		tunnel.onStatus = { states.append($0) }

		async let first: Void = tunnel.start(config)
		async let second: Void = tunnel.start(config)
		_ = await (first, second)

		let failures = states.compactMap { state -> String? in
			if case .failed(let reason) = state { return reason }
			return nil
		}
		XCTAssertEqual(failures, [], "a second start should wait, not collide")
		guard case .connected = states.last else {
			return XCTFail("expected to end up connected, got \(states)")
		}

		await tunnel.stop()
	}

	/// Leaving the browser and coming back must not build a second tunnel.
	///
	/// `BrowserModel` is `@State` on the browser view, so every push makes a new
	/// one. When each carried its own tunnel, the second could not bind the
	/// loopback port the first was still holding, which is what build 38 and 39
	/// both failed with.
	@MainActor
	func testEveryBrowserShareTheOneTunnel() {
		let first = BrowserModel(deckOrigin: URL(string: "https://example.ts.net:4818"))
		let second = BrowserModel(deckOrigin: URL(string: "https://example.ts.net:4818"))
		XCTAssertTrue(first.tunnel === second.tunnel)
		XCTAssertTrue(first.tunnel === DevTunnel.shared)
	}

	// MARK: Harness

	private static func configured() -> DevTunnel.Config? {
		let env = ProcessInfo.processInfo.environment
		guard let host = env["DECK_TUNNEL_HOST"], !host.isEmpty,
			let user = env["DECK_TUNNEL_USER"], !user.isEmpty,
			let password = env["DECK_TUNNEL_PASSWORD"], !password.isEmpty
		else { return nil }
		return DevTunnel.Config(
			host: host,
			port: Int(env["DECK_TUNNEL_PORT"] ?? "22") ?? 22,
			username: user,
			password: password,
			// A fixed port on purpose, where the app asks for 0 and takes any
			// free one. Two binds to 0 both succeed, so an ephemeral port here
			// would stop the overlapping-starts test being able to clash at all.
			localPort: Int(env["DECK_TUNNEL_LOCAL_PORT"] ?? "11080") ?? 11080)
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
