import Foundation

/// What an ask notification's action answers with: the numbered option's
/// label, or the typed reply. Nil for a plain tap or a payload with no ask.
public struct NotificationAnswer: Equatable, Sendable {
	/// Exactly one of these is set: a session's question, or a blocked run.
	public let sessionId: String?
	public let runId: String?
	public let askId: String?
	public let header: String
	public let label: String
	public let structured: Bool

	/// `optionSlot` is the numbered option action picked, `typed` the reply
	/// text; at most one is set.
	public init?(userInfo: [AnyHashable: Any], optionSlot: Int?, typed: String?) {
		guard let ask = userInfo["ask"] as? [String: Any] else { return nil }
		// A blocked run's push names the run; deck also forwards an answer posted
		// to the run's phase session, so either id is enough.
		let runId = ask["runId"] as? String
		let sessionId = ask["sessionId"] as? String
		guard runId != nil || sessionId != nil else { return nil }
		let options = ask["options"] as? [String] ?? []
		let label: String?
		if let typed {
			label = typed.trimmingCharacters(in: .whitespacesAndNewlines)
		} else if let optionSlot {
			label = options.indices.contains(optionSlot) ? options[optionSlot] : nil
		} else {
			label = nil
		}
		guard let label, !label.isEmpty else { return nil }
		self.sessionId = runId == nil ? sessionId : nil
		self.runId = runId
		self.askId = ask["askId"] as? String
		self.header = ask["header"] as? String ?? "Answer"
		self.label = label
		self.structured = (ask["questions"] as? Int ?? 1) == 1
	}
}

extension NotificationAnswer {
	/// The text a session's agent receives, the same form the ask card sends.
	public var text: String { "Answering your question:\n- \(header): \(label)" }

	/// Post the answer the way the ask card does, so the transcript shows it
	/// answered with the pick. A run takes the reply as written and hands it to
	/// its next phase session. deck turning the answer down throws its reason.
	public func post(with client: DeckClient) async throws {
		if let runId {
			_ = try await client.runAction(id: runId, .answer, text: label)
			return
		}
		guard let sessionId else { return }
		let answers = structured ? [StructuredAnswer(header: header, labels: [label])] : []
		let response = try await client.answer(sessionId: sessionId, text: text, askId: askId, answers: answers)
		if !response.ok, let reason = response.reason {
			throw DeckError.http(status: 200, message: reason)
		}
	}

	/// The body of the "Answer not sent" notification: the pick, then deck's
	/// own reason when it gave one (e.g. a 409 for a run no longer blocked).
	public func failureBody(for error: Error) -> String {
		"\"\(label)\": \(DeckError.message(for: error))"
	}
}
