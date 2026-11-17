import DeckKit
import Foundation
import NIOCore
import NIOPosix
import os

/// File-level rather than a static member: the event-loop callbacks log from
/// off the main actor, and a member of a @MainActor type cannot be read there.
private let log = Logger(subsystem: "tech.moravec.deck", category: "browser")

/// A loopback SOCKS5 listener for WKWebView to point at, carrying each
/// connection to the deck machine over its own WebSocket to deck's
/// `/api/tunnel`, signed in with the deck token.
///
/// This is the in-process equivalent of `ssh -D <port>`: no helper binary, no
/// separate process, and the SOCKS handshake names the target per connection so
/// any port on the far side works without being declared anywhere. That is the
/// whole reason the proxy sits on this side rather than publishing one origin
/// per port from deck: a page on 5173 that asks for 3000 just works.
///
/// There is no long-lived connection to lose: each proxied connection dials
/// fresh, so a network change only breaks what was in flight.
///
/// Main-actor isolated, so the listener and its status have a single owner.
/// The socket work still happens on the event loop; the awaits here only resume
/// back on main, and the NIO callbacks hop to it.
@MainActor
public final class DevTunnel {
	public struct Config: Equatable, Sendable {
		public var credentials: Credentials
		/// Routes through that session's host when it runs on a remote one. Nil
		/// is the deck machine itself.
		public var sessionId: String?
		/// The loopback port the SOCKS5 listener binds, or 0 to take any free
		/// one. 0 by default: only this app ever connects to it, and a fixed
		/// number is a clash waiting to happen.
		public var localPort: Int

		public init(credentials: Credentials, sessionId: String? = nil, localPort: Int = 0) {
			self.credentials = credentials
			self.sessionId = sessionId
			self.localPort = localPort
		}

		/// The WebSocket upgrade for one proxied connection to `port`.
		func request(port: Int) -> URLRequest? {
			guard var components = URLComponents(url: credentials.baseURL, resolvingAgainstBaseURL: false) else {
				return nil
			}
			components.scheme = components.scheme == "https" ? "wss" : "ws"
			components.path = "/api/tunnel"
			components.queryItems =
				[URLQueryItem(name: "port", value: String(port))]
				+ (sessionId.map { [URLQueryItem(name: "session", value: $0)] } ?? [])
			guard let url = components.url else { return nil }
			var request = URLRequest(url: url)
			request.setValue("Bearer \(credentials.token)", forHTTPHeaderField: "Authorization")
			return request
		}
	}

	public enum Status: Equatable, Sendable {
		case idle
		case connecting
		case connected(localPort: Int)
		case failed(String)
	}

	/// The app's tunnels, one per route: a session on a remote host reaches that
	/// host, so its browser cannot share the machine-wide listener. A tunnel per
	/// browser view instead meant leaving the browser and coming back built a
	/// second one, which could not bind the port the first still held.
	///
	/// shortcut: one listener per session browsed, kept for the app's lifetime;
	/// prune them if that ever adds up.
	public static func shared(for sessionId: String?) -> DevTunnel {
		if let tunnel = tunnels[sessionId ?? ""] { return tunnel }
		let tunnel = DevTunnel()
		tunnels[sessionId ?? ""] = tunnel
		return tunnel
	}

	private static var tunnels: [String: DevTunnel] = [:]

	/// One event loop for the app's lifetime. A group per tunnel would leak a
	/// thread every time the browser is opened, and shutting one down from
	/// `deinit` risks doing it from its own loop.
	private static let group = MultiThreadedEventLoopGroup(numberOfThreads: 1)

	private var listener: Channel?
	private var boundConfig: Config?
	/// The port last bound, asked for again on every rebind so the web views'
	/// proxy configuration stays valid and no tab has to be rebuilt.
	private var lastPort: Int?

	/// Where the tunnel currently stands, so a screen arriving after the fact
	/// can show it rather than starting from "not connected".
	public private(set) var status: Status = .idle

	/// Whatever start or stop is already running. Being main-actor isolated only
	/// stops the two bodies interleaving between statements, not across their
	/// awaits: opening the browser, a return to the foreground and a dropped
	/// listener can all land together. Two overlapping starts both find no
	/// listener to close, because neither has assigned one yet, and then both
	/// bind the same port. The second one gets EADDRINUSE.
	private var inFlight: Task<Void, Never>?

	public var onStatus: ((Status) -> Void)?
	/// The last target a request was forwarded to, for the status line.
	public var onForward: ((String, Int) -> Void)?
	public var onForwardError: ((String) -> Void)?

	public init() {}

	public func start(_ config: Config) async {
		await serialised { await self.bind(config) }
	}

	public func stop() async {
		await serialised {
			await self.closeListener()
			self.report(.idle)
		}
	}

	/// Run after whatever is already running, so no two of these overlap.
	private func serialised(_ work: @escaping @MainActor () async -> Void) async {
		let previous = inFlight
		let task = Task { @MainActor in
			await previous?.value
			await work()
		}
		inFlight = task
		await task.value
	}

	/// Rebind unless the listener is still up for this config. iOS reclaims
	/// listening sockets while suspended; one still alive is left alone, so a
	/// reload tapped on return to the foreground never lands in a rebind gap.
	private func bind(_ config: Config) async {
		if let listener, listener.isActive, boundConfig == config { return }
		await closeListener()
		if case .connected = status {} else { report(.connecting) }
		let preferred = lastPort ?? config.localPort
		do {
			let server: Channel
			do {
				server = try await listen(config, port: preferred)
			} catch where preferred != config.localPort {
				server = try await listen(config, port: config.localPort)
			}
			listener = server
			boundConfig = config
			// The port we got, not the one we asked for. With 0 the kernel picks.
			let bound = server.localAddress?.port ?? preferred
			lastPort = bound
			log.info("SOCKS5 listening on 127.0.0.1:\(bound, privacy: .public)")
			report(.connected(localPort: bound))

			// Identity, not a flag: this fires after a hop to the main actor, by
			// when a deliberate rebind has already replaced the listener.
			server.closeFuture.whenComplete { [weak self] _ in
				Task { @MainActor in
					guard let self, self.listener === server else { return }
					self.listener = nil
					await self.start(config)
				}
			}
		} catch {
			let reason = Self.readable(error, port: preferred)
			log.error("listen failed: \(reason, privacy: .public)")
			report(.failed(reason))
		}
	}

	private func listen(_ config: Config, port: Int) async throws -> Channel {
		// Called from the event loop, so each one hops to main rather than
		// touching the callbacks where it stands.
		let forwarded: @Sendable (String, Int) -> Void = { [weak self] host, port in
			Task { @MainActor in self?.onForward?(host, port) }
		}
		let refused: @Sendable (String) -> Void = { [weak self] reason in
			log.error("forward refused: \(reason, privacy: .public)")
			Task { @MainActor in self?.onForwardError?(reason) }
		}
		return try await ServerBootstrap(group: Self.group)
			.serverChannelOption(ChannelOptions.socketOption(.so_reuseaddr), value: 1)
			.childChannelInitializer { inbound in
				inbound.eventLoop.makeCompletedFuture {
					try inbound.pipeline.syncOperations.addHandler(
						SOCKS5Handler(config: config, onForward: forwarded, onForwardError: refused))
				}
			}
			.bind(host: "127.0.0.1", port: port)
			.get()
	}

	/// NIO reports a taken port as `bind(descriptor:ptr:bytes:): Address already
	/// in use (errno: 48)`, which says nothing about which port or what to do.
	private static func readable(_ error: Error, port: Int) -> String {
		if let io = error as? IOError, io.errnoCode == EADDRINUSE {
			return "local port \(port) is taken"
		}
		return "\(error)"
	}

	/// Forget the listener before closing it, so the close handler sees it is
	/// no longer the live one and stays quiet.
	private func closeListener() async {
		let server = listener
		listener = nil
		try? await server?.close().get()
	}

	private func report(_ status: Status) {
		self.status = status
		onStatus?(status)
	}
}
