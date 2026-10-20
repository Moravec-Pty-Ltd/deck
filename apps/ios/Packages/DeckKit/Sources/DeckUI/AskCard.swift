import SwiftUI
import DeckKit

public struct AskCard: View {
	let ask: DeckAsk
	/// The most height the questions take before they scroll, so a long ask
	/// never pushes the send button and the composer off screen.
	var maxQuestionsHeight: CGFloat?
	var onAnswer: (AskAnswerDraft) -> Void

	@State private var draft: AskAnswerDraft

	public init(ask: DeckAsk, maxQuestionsHeight: CGFloat? = nil, onAnswer: @escaping (AskAnswerDraft) -> Void) {
		self.ask = ask
		self.maxQuestionsHeight = maxQuestionsHeight
		self.onAnswer = onAnswer
		_draft = State(initialValue: AskAnswerDraft(questions: ask.questions))
	}

	public var body: some View {
		VStack(alignment: .leading, spacing: 12) {
			// Short asks keep their natural height; only one that overflows the
			// cap becomes a scroll view.
			ViewThatFits(in: .vertical) {
				questions
				ScrollView { questions }
			}
			.frame(maxHeight: maxQuestionsHeight)
			Button("Send answers") {
				onAnswer(draft)
			}
			.buttonStyle(.borderedProminent)
			.disabled(!draft.isComplete)
		}
	}

	private var questions: some View {
		VStack(alignment: .leading, spacing: 12) {
			ForEach(Array(ask.questions.enumerated()), id: \.offset) { index, question in
				VStack(alignment: .leading, spacing: 8) {
					if let header = question.header, !header.isEmpty {
						Text(header).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
					}
					Text(question.question).font(.body.weight(.medium))
					ForEach(question.options ?? [], id: \.label) { option in
						Button {
							draft.toggle(option.label, question: index)
						} label: {
							HStack(alignment: .top, spacing: 8) {
								Image(systemName: draft.isSelected(option.label, question: index) ? "checkmark.circle.fill" : "circle")
								VStack(alignment: .leading, spacing: 2) {
									Text(option.label)
									if let description = option.description {
										Text(description).font(.caption).foregroundStyle(.secondary)
									}
								}
								Spacer()
							}
						}
						.buttonStyle(.plain)
					}
					TextField("Or type a reply", text: Binding(
						get: { draft.reply(question: index) },
						set: { draft.setReply($0, question: index) }))
						.textFieldStyle(.roundedBorder)
				}
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
	}
}
