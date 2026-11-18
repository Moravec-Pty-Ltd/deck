import Foundation
import os
import NIOCore

/// Minimal SOCKS5 server: no authentication, CONNECT only. On CONNECT it opens
/// a WebSocket to deck's `/api/tunnel` for the requested port and hands the
/// connection to a `WebSocketBridge`, so WKWebView's request comes out on the
/// deck machine.
final class SOCKS5Handler: ChannelInboundHandler, RemovableChannelHandler {
	typealias InboundIn = ByteBuffer
	typealias OutboundOut = ByteBuffer

	private enum State { case greeting, request, piping }
	private var state: State = .greeting
	private var buffer: ByteBuffer?
	private var bridge: WebSocketBridge?
	private let config: DevTunnel.Config
	private let onForward: @Sendable (String, Int) -> Void
	private let onForwardError: @Sendable (String) -> Void

	init(
		config: DevTunnel.Config,
		onForward: @escaping @Sendable (String, Int) -> Void,
		onForwardError: @escaping @Sendable (String) -> Void
	) {
		self.config = config
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

	/// The web view gave up before deck answered.
	func channelInactive(context: ChannelHandlerContext) {
		bridge?.cancel()
		context.fireChannelInactive()
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
			refuse(context.channel, 0x01)
			return
		}

		let port = (Int(bytes[index]) << 8) | Int(bytes[index + 1])
		buf.moveReaderIndex(forwardBy: total)
		buffer = buf

		guard command == 0x01 else { // CONNECT only
			refuse(context.channel, 0x01)
			return
		}
		guard LoopbackHost.isTunnelTarget(host), let request = config.request(port: port) else {
			onForwardError("\(host):\(port) is not on the deck machine")
			refuse(context.channel, 0x02) // not allowed by ruleset
			return
		}

		state = .piping
		// Only the stand-in needs its request head rewritten; a literal loopback
		// target already carries `localhost` (or an IP) in its headers.
		let standIn = host.lowercased() == LoopbackHost.sentinel
		openForward(context: context, request: request, host: LoopbackHost.target(host), port: port, rewriteHead: standIn)
	}

	private func openForward(context: ChannelHandlerContext, request: URLRequest, host: String, port: Int, rewriteHead: Bool) {
		onForward(host, port)
		let inbound = context.channel
		let bridge = WebSocketBridge(request: request, eventLoop: context.eventLoop, rewriteHead: rewriteHead)
		self.bridge = bridge
		bridge.open { [weak self] failure in
			guard let self else { return }
			if let failure {
				self.onForwardError("\(host):\(port): \(failure)")
				self.refuse(inbound, 0x01)
				return
			}
			guard inbound.isActive else { return bridge.cancel() }
			self.reply(inbound, 0x00)
			do {
				try inbound.pipeline.syncOperations.addHandler(bridge)
			} catch {
				bridge.cancel()
				inbound.close(promise: nil)
				return
			}
			inbound.pipeline.removeHandler(self, promise: nil)
		}
	}

	private func refuse(_ channel: Channel, _ code: UInt8) {
		reply(channel, code)
		channel.close(promise: nil)
	}

	private func reply(_ channel: Channel, _ code: UInt8) {
		var reply = channel.allocator.buffer(capacity: 10)
		reply.writeBytes([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
		channel.writeAndFlush(reply, promise: nil)
	}
}

/// One proxied connection: the web view's socket on one side, a WebSocket to
/// deck on the other, raw TCP bytes as binary messages both ways.
///
/// Ordered and backpressured: reads from the web view are held while a send is
/// outstanding, and the next WebSocket message is only asked for once the last
/// one has been written. URLSession calls back on its own queue, so every
/// callback hops to the event loop before touching state, which is what makes
/// the unchecked Sendable hold.
final class WebSocketBridge: NSObject, ChannelDuplexHandler, URLSessionWebSocketDelegate, @unchecked Sendable {
	typealias InboundIn = ByteBuffer
	typealias OutboundIn = ByteBuffer
	typealias OutboundOut = ByteBuffer

	private static let session = URLSession(configuration: .ephemeral)

	private let task: URLSessionWebSocketTask
	private let eventLoop: EventLoop
	private var whenSettled: ((String?) -> Void)?
	private var context: ChannelHandlerContext?
	private var sending = 0
	private var readHeld = false
	private var head: RequestHeadRewriter?

	init(request: URLRequest, eventLoop: EventLoop, rewriteHead: Bool) {
		task = Self.session.webSocketTask(with: request)
		self.eventLoop = eventLoop
		head = rewriteHead ? RequestHeadRewriter() : nil
		super.init()
	}

	/// `settled` runs on the event loop once: nil when the WebSocket is open,
	/// or the reason it never opened.
	func open(_ settled: @escaping (String?) -> Void) {
		whenSettled = settled
		// The default 1 MB would fail any larger chunk deck forwards.
		task.maximumMessageSize = 16 << 20
		task.delegate = self
		task.resume()
	}

	func cancel() { task.cancel(with: .normalClosure, reason: nil) }

	private func settle(_ reason: String?) {
		eventLoop.execute {
			let settled = self.whenSettled
			self.whenSettled = nil
			settled?(reason)
		}
	}

	func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
		settle(nil)
	}

	/// Only matters before the open: a refused upgrade, where the status (401,
	/// 404) says more than the error.
	func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
		let status = (task.response as? HTTPURLResponse)?.statusCode
		settle(status.map { "deck answered \($0)" } ?? error?.localizedDescription ?? "closed")
	}

	func handlerAdded(context: ChannelHandlerContext) {
		self.context = context
		receive()
	}

	func handlerRemoved(context: ChannelHandlerContext) {
		self.context = nil
	}

	func channelRead(context: ChannelHandlerContext, data: NIOAny) {
		var bytes = Data(unwrapInboundIn(data).readableBytesView)
		if head != nil {
			bytes = head!.feed(bytes)
			if bytes.isEmpty { return }
		}
		sending += 1
		task.send(.data(bytes)) { error in
			self.eventLoop.execute {
				self.sending -= 1
				if error != nil { return self.close() }
				if self.sending == 0, self.readHeld {
					self.readHeld = false
					self.context?.read()
				}
			}
		}
	}

	func read(context: ChannelHandlerContext) {
		if sending > 0 { readHeld = true } else { context.read() }
	}

	func channelInactive(context: ChannelHandlerContext) {
		cancel()
		context.fireChannelInactive()
	}

	func errorCaught(context: ChannelHandlerContext, error: Error) {
		context.close(promise: nil)
	}

	private func receive() {
		task.receive { result in
			self.eventLoop.execute {
				guard let context = self.context else { return }
				guard case .success(.data(let data)) = result else {
					log.info("tunnel stream ended: \(String(describing: result), privacy: .public)")
					return self.close()
				}
				context.writeAndFlush(self.wrapOutboundOut(context.channel.allocator.buffer(bytes: data)))
					.whenSuccess { self.receive() }
			}
		}
	}

	private func close() { context?.close(promise: nil) }
}
