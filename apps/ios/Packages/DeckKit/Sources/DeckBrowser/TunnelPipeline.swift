import Foundation
import NIOConcurrencyHelpers
import NIOCore
import NIOSSH

// The SSH and SOCKS5 plumbing. Adapted from Apple's swift-nio-ssh client
// example, which does one static `-L` forward; here the SOCKS5 handshake names
// the target per connection, which is a dynamic `-D` forward. The glue and
// wrapper handlers are that example's, unchanged.

enum TunnelError: Error, CustomStringConvertible {
	case invalidChannelType
	case invalidData
	case passwordAuthUnsupported
	case authFailed
	case handshakeTimeout
	case hostKeyChanged(expected: String, got: String)

	var description: String {
		switch self {
		case .invalidChannelType: return "invalid channel type"
		case .invalidData: return "invalid channel data"
		case .passwordAuthUnsupported: return "the server rejected password auth"
		case .authFailed: return "authentication failed (check the username and password)"
		case .handshakeTimeout: return "timed out during the SSH handshake"
		case .hostKeyChanged(let expected, let got):
			return """
				the host key changed: expected \(expected), got \(got). Either the machine was \
				rebuilt or something else is answering. Forget the host in settings to accept the new key.
				"""
		}
	}
}

/// Reports "connected" only once SSH authentication actually succeeds, rather
/// than when the TCP connection opens. Also fails readiness if the connection
/// drops, errors, or is rejected before that.
///
/// Unchecked because the tunnel hands it to `@Sendable` closures. Every path
/// into it, the channel handler methods, the scheduled timeout, and the two
/// delegate rejections, runs on this connection's single event loop, which is
/// what serialises `done`.
final class AuthEventHandler: ChannelInboundHandler, @unchecked Sendable {
	typealias InboundIn = Any
	private let promise: EventLoopPromise<Void>
	private var done = false

	init(_ promise: EventLoopPromise<Void>) { self.promise = promise }

	private func finish(_ result: Result<Void, Error>) {
		guard !done else { return }
		done = true
		promise.completeWith(result)
	}

	func timeOut() { finish(.failure(TunnelError.handshakeTimeout)) }

	/// Called by the auth and host-key delegates so the real reason wins over
	/// the generic connection-closed one that follows it.
	func reject(_ error: Error) { finish(.failure(error)) }

	func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
		if event is UserAuthSuccessEvent { finish(.success(())) }
		context.fireUserInboundEventTriggered(event)
	}

	func channelInactive(context: ChannelHandlerContext) {
		finish(.failure(TunnelError.authFailed))
		context.fireChannelInactive()
	}

	func errorCaught(context: ChannelHandlerContext, error: Error) {
		finish(.failure(error))
		context.fireErrorCaught(error)
	}
}

/// Non-interactive password auth. Offers the password once; a second ask means
/// it was rejected, so it gives up rather than looping.
final class PasswordAuthDelegate: NIOSSHClientUserAuthenticationDelegate, Sendable {
	private let username: String
	private let password: String
	private let offered = NIOLockedValueBox(false)
	private let onGaveUp: @Sendable () -> Void

	init(username: String, password: String, onGaveUp: @escaping @Sendable () -> Void) {
		self.username = username
		self.password = password
		self.onGaveUp = onGaveUp
	}

	func nextAuthenticationType(
		availableMethods: NIOSSHAvailableUserAuthenticationMethods,
		nextChallengePromise: EventLoopPromise<NIOSSHUserAuthenticationOffer?>
	) {
		guard availableMethods.contains(.password) else {
			nextChallengePromise.fail(TunnelError.passwordAuthUnsupported)
			return
		}
		let alreadyTried = offered.withLockedValue { tried -> Bool in
			if tried { return true }
			tried = true
			return false
		}
		if alreadyTried {
			nextChallengePromise.succeed(nil)
			onGaveUp()
			return
		}
		nextChallengePromise.succeed(
			NIOSSHUserAuthenticationOffer(
				username: username,
				serviceName: "",
				offer: .password(.init(password: password))
			))
	}
}

/// Trust on first use. Records the key the first time and refuses a different
/// one after that. See KnownHosts for why there is no way to override it here.
final class TofuHostKeyDelegate: NIOSSHClientServerAuthenticationDelegate, Sendable {
	private let knownHosts: KnownHosts
	private let host: String
	private let port: Int
	private let onReject: @Sendable (Error) -> Void

	init(knownHosts: KnownHosts, host: String, port: Int, onReject: @escaping @Sendable (Error) -> Void) {
		self.knownHosts = knownHosts
		self.host = host
		self.port = port
		self.onReject = onReject
	}

	func validateHostKey(hostKey: NIOSSHPublicKey, validationCompletePromise: EventLoopPromise<Void>) {
		let fingerprint = KnownHosts.fingerprint(ofOpenSSHKey: String(openSSHPublicKey: hostKey))
		switch knownHosts.verify(host: host, port: port, fingerprint: fingerprint) {
		case .trusted, .learned:
			validationCompletePromise.succeed(())
		case .changed(let expected, let got):
			let error = TunnelError.hostKeyChanged(expected: expected, got: got)
			onReject(error)
			validationCompletePromise.fail(error)
		}
	}
}

/// Bridges two channels: each side writes what it reads into its partner.
final class GlueHandler {
	private var partner: GlueHandler?
	private var context: ChannelHandlerContext?
	private var pendingRead = false
	private init() {}

	static func matchedPair() -> (GlueHandler, GlueHandler) {
		let first = GlueHandler()
		let second = GlueHandler()
		first.partner = second
		second.partner = first
		return (first, second)
	}

	private func partnerWrite(_ data: NIOAny) { context?.write(data, promise: nil) }
	private func partnerFlush() { context?.flush() }
	private func partnerWriteEOF() { context?.close(mode: .output, promise: nil) }
	private func partnerCloseFull() { context?.close(promise: nil) }
	private func partnerBecameWritable() {
		if pendingRead {
			pendingRead = false
			context?.read()
		}
	}
	private var partnerWritable: Bool { context?.channel.isWritable ?? false }
}

extension GlueHandler: ChannelDuplexHandler {
	typealias InboundIn = NIOAny
	typealias OutboundIn = NIOAny
	typealias OutboundOut = NIOAny

	func handlerAdded(context: ChannelHandlerContext) {
		self.context = context
		if context.channel.isWritable { partner?.partnerBecameWritable() }
	}
	func handlerRemoved(context: ChannelHandlerContext) {
		self.context = nil
		partner = nil
	}
	func channelRead(context: ChannelHandlerContext, data: NIOAny) { partner?.partnerWrite(data) }
	func channelReadComplete(context: ChannelHandlerContext) { partner?.partnerFlush() }
	func channelInactive(context: ChannelHandlerContext) { partner?.partnerCloseFull() }
	func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
		if let event = event as? ChannelEvent, case .inputClosed = event {
			partner?.partnerWriteEOF()
		}
	}
	func errorCaught(context: ChannelHandlerContext, error: Error) { partner?.partnerCloseFull() }
	func channelWritabilityChanged(context: ChannelHandlerContext) {
		if context.channel.isWritable { partner?.partnerBecameWritable() }
	}
	func read(context: ChannelHandlerContext) {
		if let partner, partner.partnerWritable {
			context.read()
		} else {
			pendingRead = true
		}
	}
}

/// Wraps and unwraps raw bytes as SSHChannelData on an SSH child channel.
final class SSHWrapperHandler: ChannelDuplexHandler {
	typealias InboundIn = SSHChannelData
	typealias InboundOut = ByteBuffer
	typealias OutboundIn = ByteBuffer
	typealias OutboundOut = SSHChannelData

	func channelRead(context: ChannelHandlerContext, data: NIOAny) {
		let data = unwrapInboundIn(data)
		guard case .channel = data.type, case .byteBuffer(let buffer) = data.data else {
			context.fireErrorCaught(TunnelError.invalidData)
			return
		}
		context.fireChannelRead(wrapInboundOut(buffer))
	}

	func write(context: ChannelHandlerContext, data: NIOAny, promise: EventLoopPromise<Void>?) {
		let buffer = unwrapOutboundIn(data)
		context.write(wrapOutboundOut(SSHChannelData(type: .channel, data: .byteBuffer(buffer))), promise: promise)
	}
}

final class CloseOnErrorHandler: ChannelInboundHandler {
	typealias InboundIn = Any
	func errorCaught(context: ChannelHandlerContext, error: Error) {
		context.close(promise: nil)
	}
}

/// Minimal SOCKS5 server: no authentication, CONNECT only. On CONNECT it opens
/// an SSH direct-tcpip channel to the requested target and glues the two
/// together, so WKWebView's request comes out on the deck machine.
final class SOCKS5Handler: ChannelInboundHandler, RemovableChannelHandler {
	typealias InboundIn = ByteBuffer
	typealias OutboundOut = ByteBuffer

	private enum State { case greeting, request, piping }
	private var state: State = .greeting
	private var buffer: ByteBuffer?
	private let sshChannel: Channel
	private let onForward: @Sendable (String, Int) -> Void
	private let onForwardError: @Sendable (String) -> Void

	init(
		sshChannel: Channel,
		onForward: @escaping @Sendable (String, Int) -> Void,
		onForwardError: @escaping @Sendable (String) -> Void
	) {
		self.sshChannel = sshChannel
		self.onForward = onForward
		self.onForwardError = onForwardError
	}

	func channelRead(context: ChannelHandlerContext, data: NIOAny) {
		if state == .piping {
			context.fireChannelRead(data)
			return
		}
		var incoming = unwrapInboundIn(data)
		if buffer == nil { buffer = incoming } else { buffer!.writeBuffer(&incoming) }
		advance(context: context)
	}

	private func advance(context: ChannelHandlerContext) {
		switch state {
		case .greeting: parseGreeting(context: context)
		case .request: parseRequest(context: context)
		case .piping: break
		}
	}

	private func parseGreeting(context: ChannelHandlerContext) {
		guard var buf = buffer else { return }
		let bytes = Array(buf.readableBytesView)
		guard bytes.count >= 2 else { return }
		let methodCount = Int(bytes[1])
		guard bytes.count >= 2 + methodCount else { return }
		buf.moveReaderIndex(forwardBy: 2 + methodCount)
		buffer = buf

		var reply = context.channel.allocator.buffer(capacity: 2)
		reply.writeBytes([0x05, 0x00]) // version 5, no authentication
		context.writeAndFlush(wrapOutboundOut(reply), promise: nil)

		state = .request
		advance(context: context)
	}

	private func parseRequest(context: ChannelHandlerContext) {
		guard var buf = buffer else { return }
		let bytes = Array(buf.readableBytesView)
		guard bytes.count >= 4 else { return }
		let command = bytes[1]
		let addressType = bytes[3]

		let host: String
		let total: Int
		var index = 4

		switch addressType {
		case 0x01: // IPv4
			total = 4 + 4 + 2
			guard bytes.count >= total else { return }
			host = "\(bytes[4]).\(bytes[5]).\(bytes[6]).\(bytes[7])"
			index = 8
		case 0x03: // domain name
			guard bytes.count >= 5 else { return }
			let length = Int(bytes[4])
			total = 4 + 1 + length + 2
			guard bytes.count >= total else { return }
			host = String(bytes: bytes[5..<(5 + length)], encoding: .utf8) ?? ""
			index = 5 + length
		case 0x04: // IPv6
			total = 4 + 16 + 2
			guard bytes.count >= total else { return }
			host = stride(from: 0, to: 16, by: 2)
				.map { String(format: "%02x%02x", bytes[4 + $0], bytes[4 + $0 + 1]) }
				.joined(separator: ":")
			index = 20
		default:
			sendReply(context: context, success: false)
			context.close(promise: nil)
			return
		}

		let port = (Int(bytes[index]) << 8) | Int(bytes[index + 1])
		buf.moveReaderIndex(forwardBy: total)
		buffer = buf

		guard command == 0x01 else { // CONNECT only
			sendReply(context: context, success: false)
			context.close(promise: nil)
			return
		}

		state = .piping
		openForward(context: context, host: LoopbackHost.target(host), port: port)
	}

	/// The one seam in the whole tunnel: everything above decides *what* to
	/// connect to, this decides *how*. Swapping SSH for a relay on deck's own
	/// token is a change to this function and nothing else.
	private func openForward(context: ChannelHandlerContext, host: String, port: Int) {
		onForward(host, port)
		let inbound = context.channel
		let eventLoop = context.eventLoop

		let sshHandler: NIOSSHHandler
		do {
			sshHandler = try sshChannel.pipeline.syncOperations.handler(type: NIOSSHHandler.self)
		} catch {
			sendReply(context: context, success: false)
			context.close(promise: nil)
			return
		}

		let originator = inbound.remoteAddress ?? (try? SocketAddress(ipAddress: "127.0.0.1", port: 0))
		guard let originator else {
			sendReply(context: context, success: false)
			context.close(promise: nil)
			return
		}
		let directTCPIP = SSHChannelType.DirectTCPIP(
			targetHost: host,
			targetPort: port,
			originatorAddress: originator
		)

		let (ours, theirs) = GlueHandler.matchedPair()
		let promise = eventLoop.makePromise(of: Channel.self)

		sshHandler.createChannel(promise, channelType: .directTCPIP(directTCPIP)) { childChannel, channelType in
			guard case .directTCPIP = channelType else {
				return childChannel.eventLoop.makeFailedFuture(TunnelError.invalidChannelType)
			}
			return childChannel.eventLoop.makeCompletedFuture {
				let sync = childChannel.pipeline.syncOperations
				try sync.addHandler(SSHWrapperHandler())
				try sync.addHandler(ours)
				try sync.addHandler(CloseOnErrorHandler())
			}
		}

		promise.futureResult.whenComplete { [weak self] result in
			guard let self else { return }
			switch result {
			case .success:
				do {
					try inbound.pipeline.syncOperations.addHandler(theirs)
				} catch {
					inbound.close(promise: nil)
					return
				}
				self.sendReply(channel: inbound, success: true)
				inbound.pipeline.removeHandler(self).whenComplete { _ in }
			case .failure(let error):
				// Usually AllowTcpForwarding off on the server, or nothing
				// listening on that port.
				self.onForwardError("\(host):\(port) — \(error)")
				self.sendReply(channel: inbound, success: false)
				inbound.close(promise: nil)
			}
		}
	}

	private func sendReply(context: ChannelHandlerContext, success: Bool) {
		context.writeAndFlush(wrapOutboundOut(Self.reply(context.channel.allocator, success)), promise: nil)
	}

	private func sendReply(channel: Channel, success: Bool) {
		channel.writeAndFlush(Self.reply(channel.allocator, success), promise: nil)
	}

	private static func reply(_ allocator: ByteBufferAllocator, _ success: Bool) -> ByteBuffer {
		var reply = allocator.buffer(capacity: 10)
		reply.writeBytes([0x05, success ? 0x00 : 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
		return reply
	}
}
