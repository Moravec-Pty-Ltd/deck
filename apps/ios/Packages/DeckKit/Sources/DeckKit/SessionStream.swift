import Foundation

/// A parsed frame from a session's live SSE transcript stream.
public enum SessionStreamEvent: Sendable {
	/// Session status changed (e.g. "running", "idle").
	case status(String)
	/// Recent stored history, sent once when the stream opens. `start` is the
	/// absolute index of `events[0]`: anything before it lives on the server and
	/// loads on demand through the history endpoint.
	case snapshot(events: [JSONValue], start: Int)
	/// One persisted transcript event (an assistant message, a tool result, a
	/// deck marker) to fold into the transcript.
	case transcript(JSONValue)
	/// The agent began a new reply; the streamed text so far belongs to the
	/// previous one and should be cleared.
	case turnStart
	/// A streamed text delta to append to the in-progress assistant reply.
	case textDelta(String)
	/// The session's claude process exited, taking any running subagent with it.
	case exit
}

extension DeckClient {
	/// Live transcript stream for a session via deck's per-session SSE endpoint
	/// (`/api/agent/sessions/{id}/stream`): stored history first, then token deltas and
	/// persisted events as the agent works. The stream ends (or throws) when the
	/// connection drops; the caller reconnects.
	public func sessionEventStream(sessionId: String) -> AsyncThrowingStream<SessionStreamEvent, Error> {
		AsyncThrowingStream { continuation in
			let task = Task {
				let session = URLSession(configuration: self.streamConfiguration())
				defer { session.invalidateAndCancel() }
				do {
					let request = try self.streamRequest(path: "/api/agent/sessions/\(sessionId)/stream")
					let (bytes, response) = try await session.bytes(for: request)
					guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
						throw DeckError.http(
							status: (response as? HTTPURLResponse)?.statusCode ?? 0,
							message: "stream failed")
					}

					var snapshot = SnapshotAssembler()
					var eventName = ""
					var dataLines: [String] = []
					func flush() {
						defer {
							eventName = ""
							dataLines = []
						}
						guard !eventName.isEmpty, !dataLines.isEmpty else { return }
						emitFrame(eventName, dataLines.joined(separator: "\n"), &snapshot, continuation)
					}
					// URLSession's line sequence drops the blank line that ends an
					// SSE frame, so a frame ends at its data line (deck writes one
					// per event) or at the next event line, never at a blank one.
					for try await line in bytes.lines {
						if line.hasPrefix("event:") {
							flush()
							eventName = sseField(line, "event:")
						} else if line.hasPrefix("data:") {
							dataLines.append(sseField(line, "data:"))
							flush()
						}
					}
					flush()
					continuation.finish()
				} catch {
					continuation.finish(throwing: error)
				}
			}
			continuation.onTermination = { _ in task.cancel() }
		}
	}
}

extension DeckClient {
	/// A generic SSE subscription: every frame is handed to `parse`, and what it
	/// returns is yielded. Frames end at their data line, as in sessionEventStream.
	func serverEvents<T: Sendable>(path: String, parse: @escaping @Sendable (String, String) -> T?) -> AsyncThrowingStream<T, Error> {
		AsyncThrowingStream { continuation in
			let task = Task {
				let session = URLSession(configuration: self.streamConfiguration())
				defer { session.invalidateAndCancel() }
				do {
					let (bytes, response) = try await session.bytes(for: self.streamRequest(path: path))
					guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
						throw DeckError.http(status: (response as? HTTPURLResponse)?.statusCode ?? 0, message: "stream failed")
					}
					var eventName = ""
					for try await line in bytes.lines {
						if line.hasPrefix("event:") {
							eventName = sseField(line, "event:")
						} else if line.hasPrefix("data:") {
							if let value = parse(eventName, sseField(line, "data:")) { continuation.yield(value) }
							eventName = ""
						}
					}
					continuation.finish()
				} catch {
					continuation.finish(throwing: error)
				}
			}
			continuation.onTermination = { _ in task.cancel() }
		}
	}
}

extension DeckClient {
	/// The client's own configuration (so a test stub sees streams too) with
	/// timeouts for a long-lived stream. The request timeout resets on each
	/// byte, and deck pings every 25s, well within it.
	fileprivate func streamConfiguration() -> URLSessionConfiguration {
		let config = session.configuration
		config.timeoutIntervalForRequest = 60
		config.timeoutIntervalForResource = 86_400
		return config
	}

	fileprivate func streamRequest(path: String) throws -> URLRequest {
		var request = try request(path: path)
		request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
		return request
	}
}

/// deck chunks the history payload across several `snapshot` frames so it
/// flushes promptly; collect them in order and decode once the last one lands.
private struct SnapshotAssembler {
	private var chunks: [Int: String] = [:]
	private var total = 0

	mutating func add(_ frame: JSONValue) -> (events: [JSONValue], start: Int)? {
		guard let seq = frame["seq"].int, let count = frame["n"].int else { return nil }
		if seq == 0 { chunks = [:] }
		total = count
		chunks[seq] = frame["data"].string ?? ""
		guard chunks.count == total else { return nil }
		let payload = (0..<total).compactMap { chunks[$0] }.joined()
		chunks = [:]
		total = 0
		let history = JSONValue.parse(Data(payload.utf8))
		return (history?["events"].array ?? [], history?["start"].int ?? 0)
	}
}

private func sseField(_ line: String, _ prefix: String) -> String {
	var value = String(line.dropFirst(prefix.count))
	if value.hasPrefix(" ") { value.removeFirst() }
	return value
}

private func emitFrame(
	_ event: String,
	_ data: String,
	_ snapshot: inout SnapshotAssembler,
	_ continuation: AsyncThrowingStream<SessionStreamEvent, Error>.Continuation
) {
	guard !event.isEmpty, event != "ping" else { return }
	switch event {
	case "status":
		if let status = try? JSONDecoder().decode(String.self, from: Data(data.utf8)) {
			continuation.yield(.status(status))
		}
	case "snapshot":
		guard let frame = JSONValue.parse(Data(data.utf8)) else { return }
		if let history = snapshot.add(frame) {
			continuation.yield(.snapshot(events: history.events, start: history.start))
		}
	case "transcript":
		guard let value = JSONValue.parse(Data(data.utf8)) else { return }
		// A subagent's deltas would cut into the main thread's live bubble.
		if value["type"].string == "stream_event", !(value["parent_tool_use_id"].string ?? "").isEmpty { return }
		if let text = textDelta(from: value) {
			continuation.yield(.textDelta(text))
		} else if value["type"].string == "stream_event" {
			if value["event"]["type"].string == "message_start" { continuation.yield(.turnStart) }
		} else {
			continuation.yield(.transcript(value))
		}
	case "exit":
		continuation.yield(.exit)
	default:
		break
	}
}

// stream_event -> content_block_delta -> text_delta.text (mirrors the web client).
private func textDelta(from value: JSONValue) -> String? {
	guard value["type"].string == "stream_event",
		value["event"]["type"].string == "content_block_delta",
		value["event"]["delta"]["type"].string == "text_delta"
	else { return nil }
	return value["event"]["delta"]["text"].string
}
