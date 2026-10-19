import SwiftUI
import WatchKit
import DeckKit

/// Answer a blocking ask from the wrist. Every question gets answered, one
/// screen at a time; the answers go up together, the same text and picks the
/// phone and web send. A lone single-choice question still answers on one tap.
struct AskDetailView: View {
	@Environment(DeckStore.self) private var store
	@Environment(\.dismiss) private var dismiss
	let ask: DeckAsk

	@State private var draft: AskAnswerDraft
	@State private var index = 0
	@State private var isSubmitting = false
	@State private var errorMessage: String?

	init(ask: DeckAsk) {
		self.ask = ask
		_draft = State(initialValue: AskAnswerDraft(questions: ask.questions))
	}

	private var question: AskQuestion? {
		ask.questions.indices.contains(index) ? ask.questions[index] : nil
	}
	private var isLast: Bool { index >= ask.questions.count - 1 }
	/// One question with one pick: tapping an option is the whole answer. A
	/// question with no options (a blocked run's) is answered by reply and Send.
	private var answersOnTap: Bool {
		ask.questions.count == 1 && question?.multiSelect != true && !(question?.options ?? []).isEmpty
	}

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 12) {
				if ask.questions.count > 1 {
					Text("Question \(index + 1) of \(ask.questions.count)")
						.font(.caption2)
						.foregroundStyle(.secondary)
				}
				if let header = question?.header, !header.isEmpty {
					Text(header).font(.headline)
				}
				if let question {
					Text(question.question).font(.body)
				}

				if let options = question?.options, !options.isEmpty {
					optionButtons(options)
				}

				Divider()

				VStack(alignment: .leading, spacing: 4) {
					Text("Or type a reply")
						.font(.caption)
						.foregroundStyle(.secondary)
					TextField("Reply", text: Binding(
						get: { draft.reply(question: index) },
						set: { draft.setReply($0, question: index) }))
				}

				if !answersOnTap {
					navigation
				}
			}
			.padding(.horizontal)
			.padding(.bottom)
		}
		.navigationTitle("Question")
		.disabled(isSubmitting)
		.alert("Couldn't send", isPresented: Binding(
			get: { errorMessage != nil },
			set: { if !$0 { errorMessage = nil } }
		)) {
			Button("OK", role: .cancel) { errorMessage = nil }
		} message: {
			Text(errorMessage ?? "")
		}
	}

	@ViewBuilder
	private func optionButtons(_ options: [AskOption]) -> some View {
		VStack(spacing: 8) {
			ForEach(options, id: \.label) { option in
				Button {
					draft.toggle(option.label, question: index)
					if answersOnTap { submit() }
				} label: {
					optionLabel(option, selected: draft.isSelected(option.label, question: index))
				}
				.buttonStyle(.bordered)
			}
		}
	}

	/// Next until the last question, then Send; either needs this question
	/// answered first.
	private var navigation: some View {
		HStack {
			if index > 0 {
				Button("Back") { index -= 1 }
					.buttonStyle(.bordered)
			}
			if isLast {
				Button("Send") { submit() }
					.buttonStyle(.borderedProminent)
					.disabled(!draft.isComplete || isSubmitting)
			} else {
				Button("Next") { index += 1 }
					.buttonStyle(.borderedProminent)
					.disabled(!draft.isAnswered(question: index))
			}
		}
	}

	private func optionLabel(_ option: AskOption, selected: Bool) -> some View {
		HStack {
			VStack(alignment: .leading, spacing: 2) {
				Text(option.label)
				if let description = option.description {
					Text(description)
						.font(.caption2)
						.foregroundStyle(.secondary)
				}
			}
			Spacer(minLength: 0)
			if selected {
				Image(systemName: "checkmark.circle.fill")
					.foregroundStyle(.green)
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
	}

	private func submit() {
		guard draft.isComplete else { return }
		isSubmitting = true
		Task {
			do {
				try await store.answer(ask: ask, text: draft.text, answers: draft.answers)
				WKInterfaceDevice.current().play(.success)
				dismiss()
			} catch {
				errorMessage = error.localizedDescription
			}
			isSubmitting = false
		}
	}
}
