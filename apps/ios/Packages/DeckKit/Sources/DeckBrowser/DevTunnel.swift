import Foundation
import NIOCore
import NIOPosix
import NIOSSH
import os

/// File-level rather than a static member: the event-loop callbacks log from
/// off the main actor, and a member of a @MainActor type cannot be read there.
private let log = Logger(subsystem: "tech.moravec.deck", category: "browser")

/// Opens an SSH connection to the deck machine and exposes a loopback SOCKS5
/// listener for WKWebView to point at.
///
/// This is the in-process equivalent of `ssh -D <port>`: no helper binary, no
/// separate process, and the SOCKS handshake names the target per connection so
/// any port on the far side works without being declared anywhere. That is the
/// whole reason the proxy sits on this side rather than publishing one origin
/// per port from deck: a page on 5173 that asks for 3000 just works.
///
/// Main-actor isolated, so the channels and the stop flag have a single owner.
/// The socket work still happens on the event loop; the awaits here only resume
/// back on main, and the NIO callbacks hop to it.
@MainActor
public final class DevTunnel {
	public struct Config: Equatable, Sendable {
		public var host: String
		public var port: Int
		public var username: String
		public var password: String
		public var localPort: Int

		public init(host: String, port: Int, username: String, password: String, localPort: Int) {
			self.host = host
			self.port = port
			self.username = username
			self.password = password
			self.localPort = localPort
		}

		public init?(settings: TunnelSettings, password: String) {
			guard settings.isComplete else { return nil }
			self.init(
				host: settings.host.trimmingCharacters(in: .whitespaces),
				port: settings.port,
				username: settings.username.trimmingCharacters(in: .whitespaces),
				password: password,
				localPort: settings.localPort)
		}
	}

	public enum Status: Equatable, Sendable {
		case idle
		case connecting
		case connected(localPort: Int)
		case failed(String)
	}

	/// The app's tunnel. One SSH connection to one machine, holding one loopback
	/// port, so it belongs to the app rather than to whichever screen asked for
	/// it. A tunnel per browser view meant leaving the browser and coming back
	/// built a second one, which could not bind the port the first still held.
	public static let shared = DevTunnel()

	/// One event loop for the app's lifetime. A group per tunnel would leak a
	/// thread every time the browser is opened, and shutting one down from
	/// `deinit` risks doing it from its own loop.
	private static let group = MultiThreadedEventLoopGroup(numberOfThreads: 1)

	private let knownHosts: KnownHosts
	private var sshChannel: Channel?
	private var socksChannel: Channel?

	/// Where the tunnel currently stands, so a screen arriving after the fact
	/// can show it rather than starting from "not connected" and reconnecting an
	/// already-live tunnel.
	public private(set) var status: Status = .idle

	/// Whatever start or stop is already running. Being main-actor isolated only
	/// stops the two bodies interleaving between statements, not across their
	/// awaits, and there are several: auto-connect on open, a tap on Connect, a
	/// return to the foreground and a backoff retry can all land together. Two
	/// overlapping starts both find no listener to close, because neither has
	/// assigned one yet, and then both bind the same port. The second one gets
	/// EADDRINUSE.
	private var inFlight: Task<Void, Never>?

	public var onStatus: ((Status) -> Void)?
	/// The last target a request was forwarded to, for the status line.
	public var onForward: ((String, Int) -> Void)?
	public var onForwardError: ((String) -> Void)?

	public init(knownHosts: KnownHosts = KnownHosts()) {
		self.knownHosts = knownHosts
	}

	public func start(_ config: Config) async {
		await serialised { await self.connect(config) }
	}

	public func stop() async {
		await serialised {
			await self.closeChannels()
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

	private func connect(_ config: Config) async {
		// Clean slate first, or the SOCKS listener's old bind fails the new one
		// with "address already in use".
		await closeChannels()
		report(.connecting)

		do {
			let authPromise = Self.group.next().makePromise(of: Void.self)
			let authHandler = AuthEventHandler(authPromise)
			let auth = PasswordAuthDelegate(
				username: config.username,
				password: config.password,
				onGaveUp: { authHandler.reject(TunnelError.authFailed) })
			let hostKeys = TofuHostKeyDelegate(
				knownHosts: knownHosts,
				host: config.host,
				port: config.port,
				onReject: { authHandler.reject($0) })

			// Bounded, so an unreachable or firewalled host fails visibly rather
			// than hanging on the default TCP timeout.
			let ssh = try await ClientBootstrap(group: Self.group)
				.connectTimeout(.seconds(12))
				.channelInitializer { channel in
					channel.eventLoop.makeCompletedFuture {
						let handler = NIOSSHHandler(
							role: .client(.init(userAuthDelegate: auth, serverAuthDelegate: hostKeys)),
							allocator: channel.allocator,
							inboundChildChannelInitializer: nil)
						try channel.pipeline.syncOperations.addHandler(handler)
						try channel.pipeline.syncOperations.addHandler(authHandler)
						try channel.pipeline.syncOperations.addHandler(CloseOnErrorHandler())
					}
				}
				.connect(host: config.host, port: config.port)
				.get()
			sshChannel = ssh

			// TCP being up is not the tunnel being up. Wait for authentication.
			let timeout = ssh.eventLoop.scheduleTask(in: .seconds(15)) { authHandler.timeOut() }
			authPromise.futureResult.whenComplete { _ in timeout.cancel() }
			try await authPromise.futureResult.get()

			// Called from the event loop, so each one hops to main rather than
			// touching the callbacks where it stands.
			let forwarded: @Sendable (String, Int) -> Void = { [weak self] host, port in
				Task { @MainActor in self?.onForward?(host, port) }
			}
			let refused: @Sendable (String) -> Void = { [weak self] reason in
				log.error("forward refused: \(reason, privacy: .public)")
				Task { @MainActor in self?.onForwardError?(reason) }
			}

			let server = try await ServerBootstrap(group: Self.group)
				.serverChannelOption(ChannelOptions.socketOption(.so_reuseaddr), value: 1)
				.childChannelOption(ChannelOptions.allowRemoteHalfClosure, value: true)
				.childChannelInitializer { inbound in
					inbound.eventLoop.makeCompletedFuture {
						try inbound.pipeline.syncOperations.addHandler(
							SOCKS5Handler(sshChannel: ssh, onForward: forwarded, onForwardError: refused))
					}
				}
				.bind(host: "127.0.0.1", port: config.localPort)
				.get()
			socksChannel = server
			// The port we got, not the one we asked for. With 0 the kernel picks,
			// and even with a number the only truth is what the socket bound.
			let bound = server.localAddress?.port ?? config.localPort
			log.info("SOCKS5 listening on 127.0.0.1:\(bound, privacy: .public)")
			report(.connected(localPort: bound))

			// Once we are up, a drop is a failure rather than a clean stop. Free
			// the listener with it so the next attempt can rebind the port.
			//
			// Identity, not a flag: this fires after a hop to the main actor, so
			// a flag set during a deliberate teardown has already been cleared by
			// the start that replaced us, and every restart would report a drop
			// it caused itself. If this is no longer the live connection, its
			// closing is expected and nobody needs telling.
			ssh.closeFuture.whenComplete { [weak self] _ in
				Task { @MainActor in
					guard let self, self.sshChannel === ssh else { return }
					self.socksChannel?.close(promise: nil)
					self.socksChannel = nil
					self.sshChannel = nil
					self.report(.failed("connection dropped"))
				}
			}
		} catch {
			let reason = Self.readable(error, config: config)
			log.error("connect failed: \(reason, privacy: .public)")
			// Tear down without reporting idle, so the reason stays on screen.
			await closeChannels()
			report(.failed(reason))
		}
	}

	/// NIO reports a taken port as `bind(descriptor:ptr:bytes:): Address already
	/// in use (errno: 48)`, which says nothing about which port or what to do.
	private static func readable(_ error: Error, config: Config) -> String {
		if let tunnel = error as? TunnelError { return tunnel.description }
		if let io = error as? IOError, io.errnoCode == EADDRINUSE {
			return "local port \(config.localPort) is taken. Pick another one."
		}
		return "\(error)"
	}

	/// Accept the machine's current host key next time. The way out of a
	/// mismatch whose cause you know.
	public func forgetHostKey(_ config: Config) {
		knownHosts.forget(host: config.host, port: config.port)
	}

	/// Forget the channels before closing them, so the drop handler sees it is
	/// no longer the live connection and stays quiet.
	private func closeChannels() async {
		let socks = socksChannel
		let ssh = sshChannel
		socksChannel = nil
		sshChannel = nil
		try? await socks?.close().get()
		try? await ssh?.close().get()
	}

	private func report(_ status: Status) {
		self.status = status
		onStatus?(status)
	}
}
