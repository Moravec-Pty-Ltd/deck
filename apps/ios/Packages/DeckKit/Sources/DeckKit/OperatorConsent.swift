import Foundation

/// The user's go-ahead for operator actions that change something, held in
/// code rather than left to the model. A tool that would send, answer or start
/// holds its action here instead of running it; the brain asks the question
/// itself, in its own words, and runs exactly the held actions when the user's
/// next words are a plain yes. Anything else drops them. The model reads
/// session replies as well as the user, so neither its say-so nor its relaying
/// of the question is the guard.
actor OperatorConsent {
	struct Held: Sendable {
		/// What the user is asked to agree to, e.g. `send "run the tests" to Auth`.
		let action: String
		let run: @Sendable () async -> String
	}

	private var held: [Held] = []

	/// Longest action the user is asked about: all of it is read out, since
	/// what they agree to must be all of what runs.
	static let longestAction = 300

	/// Hold an action, or say why not; the same one held twice (a retried
	/// turn) is asked once.
	func hold(_ action: String, run: @escaping @Sendable () async -> String) -> String {
		guard action.count <= Self.longestAction else {
			return "Not held: too long to read out for the user to confirm. Shorten it and call again."
		}
		guard held.count < 3 else { return "Not held: three actions are already waiting for the user's yes." }
		if !held.contains(where: { $0.action == action }) { held.append(Held(action: action, run: run)) }
		return "Held: the app will ask the user to confirm this. Do not ask them yourself, and do not say it is done."
	}

	/// Forget what is held: the turn failed, or the operator spoke of something
	/// else, so the user's next yes would not be a reply to the question.
	func drop() {
		held = []
	}


	/// Run the held actions when `reply` is a yes; otherwise drop them. Nil when
	/// nothing ran, so the reply goes to the model as usual.
	func answer(_ reply: String) async -> String? {
		let actions = held
		held = []
		guard !actions.isEmpty, Self.isYes(reply) else { return nil }
		var results: [String] = []
		for action in actions { results.append(await action.run()) }
		return results.joined(separator: " ")
	}

	/// The question for whatever this turn held, or nil.
	func question() -> String? {
		guard !held.isEmpty else { return nil }
		return "Shall I " + held.map(\.action).joined(separator: ", and ") + "?"
	}

	private static let yesWords: Set<String> = [
		"yes", "yeah", "yep", "yup", "sure", "ok", "okay", "confirm", "confirmed", "correct", "affirmative"
	]
	private static let yesPhrases: Set<String> = [
		"go ahead", "do it", "send it", "start it", "answer it", "go for it", "sounds good", "proceed", "that's right"
	]

	/// A plain yes: a yes word, one of a few short phrases, or both, with an
	/// optional "please". Anything more ("yes, but...", "yes what is that") is not.
	static func isYes(_ text: String) -> Bool {
		// A number names something ("yes 2", "session 3"), so it is never a plain yes.
		if text.contains(where: \.isNumber) { return false }
		var words = text.lowercased().replacingOccurrences(of: "\u{2019}", with: "'")
			.components(separatedBy: CharacterSet.letters.union(CharacterSet(charactersIn: "'")).inverted)
			.filter { !$0.isEmpty && $0 != "please" }
		var saidYes = false
		if let first = words.first, yesWords.contains(first) {
			saidYes = true
			words.removeFirst()
		}
		let rest = words.joined(separator: " ")
		return rest.isEmpty ? saidYes : yesPhrases.contains(rest)
	}
}
