import Foundation

/// The answers a person is assembling for a blocking ask, one entry per
/// question, and the message they submit as. Shared by the phone's ask card
/// and the watch's question flow so both post the same text and the same
/// structured picks the web ask card does.
public struct AskAnswerDraft: Equatable, Sendable {
	public let questions: [AskQuestion]
	/// Picked option labels per question index.
	public private(set) var selected: [Int: Set<String>] = [:]
	/// A typed reply per question index, kept alongside any picks.
	public private(set) var replies: [Int: String] = [:]

	public init(questions: [AskQuestion]) {
		self.questions = questions
	}

	public var isEmpty: Bool { questions.isEmpty }

	public func isSelected(_ label: String, question index: Int) -> Bool {
		selected[index, default: []].contains(label)
	}

	/// Pick an option. A single-select question keeps one pick; a multi-select
	/// toggles the label in and out.
	public mutating func toggle(_ label: String, question index: Int) {
		guard questions.indices.contains(index) else { return }
		if questions[index].multiSelect == true {
			if selected[index, default: []].contains(label) {
				selected[index, default: []].remove(label)
			} else {
				selected[index, default: []].insert(label)
			}
		} else {
			selected[index] = selected[index] == [label] ? [] : [label]
		}
	}

	public func reply(question index: Int) -> String {
		replies[index, default: ""]
	}

	public mutating func setReply(_ text: String, question index: Int) {
		replies[index] = text
	}

	/// The labels one question is answered with, in option order, followed by
	/// the typed reply when there is one.
	public func labels(question index: Int) -> [String] {
		guard questions.indices.contains(index) else { return [] }
		let options = questions[index].options ?? []
		var labels = options.map(\.label).filter { selected[index, default: []].contains($0) }
		let reply = reply(question: index).trimmingCharacters(in: .whitespacesAndNewlines)
		if !reply.isEmpty { labels.append(reply) }
		return labels
	}

	public func isAnswered(question index: Int) -> Bool {
		!labels(question: index).isEmpty
	}

	/// Every question has a pick or a typed reply.
	public var isComplete: Bool {
		!questions.isEmpty && questions.indices.allSatisfy(isAnswered(question:))
	}

	/// The picks as deck stores them, keyed by header (falling back to the
	/// question text, as the web card does).
	public var answers: [StructuredAnswer] {
		questions.enumerated().map { index, question in
			StructuredAnswer(header: question.header ?? question.question, labels: labels(question: index))
		}
	}

	/// The text the agent receives, in the same form the web card sends.
	public var text: String {
		let lines = answers.map { "- \($0.header): \($0.labels.joined(separator: ", "))" }
		return "Answering your question\(questions.count > 1 ? "s" : ""):\n" + lines.joined(separator: "\n")
	}
}
