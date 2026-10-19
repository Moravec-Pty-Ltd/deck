import XCTest
@testable import DeckKit

/// Drives the real on-device model against a running deck. Point it at one
/// with `DECK_OPERATOR_TEST_URL` / `DECK_OPERATOR_TEST_TOKEN`; without them the
/// tests skip, so a machine with no deck (or no Apple Intelligence) still runs
/// the suite green. Read-only: it asks questions, it never starts or stops
/// anything.
final class OperatorBrainTests: XCTestCase {
	private var url: String? { ProcessInfo.processInfo.environment["DECK_OPERATOR_TEST_URL"] }
	private var token: String? { ProcessInfo.processInfo.environment["DECK_OPERATOR_TEST_TOKEN"] }

	@MainActor
	private func brain() throws -> OperatorBrain {
		guard let url, let token, let baseURL = URL(string: url) else {
			throw XCTSkip("set DECK_OPERATOR_TEST_URL and DECK_OPERATOR_TEST_TOKEN to run the operator tests")
		}
		guard OperatorBrain.availability == .available else {
			throw XCTSkip("the on-device model is not available here: \(OperatorBrain.availability)")
		}
		return OperatorBrain(client: DeckClient(credentials: Credentials(baseURL: baseURL, token: token)))
	}

	/// The whole point: a spoken question has to reach deck's API through a
	/// tool and come back as something a person would say.
	@MainActor
	func testAnsweringAQuestionAboutSessionsCallsDeck() async throws {
		let brain = try brain()
		let reply = try await brain.send("What sessions are running right now?")
		XCTAssertFalse(reply.isEmpty, "the operator said nothing")
		// It can only know a title by having called list_sessions.
		XCTAssertTrue(
			reply.localizedCaseInsensitiveContains("session") || reply.count > 20,
			"reply does not look like an answer about sessions: \(reply)")
	}

	/// Two turns, where the second only makes sense if the first is remembered.
	@MainActor
	func testTheConversationCarriesAcrossTurns() async throws {
		let brain = try brain()
		_ = try await brain.send("What sessions are running right now?")
		let reply = try await brain.send("How many was that?")
		XCTAssertFalse(reply.isEmpty, "the follow-up got nothing back")
	}

	@MainActor
	func testSummarisingAReplyGivesOneShortSentence() async throws {
		let brain = try brain()
		let summary = try await brain.summarise(
			reply: """
				I rotated the signing key, updated the three call sites in auth/session.ts, \
				and all 12 tests pass. The migration still needs running on staging.
				""",
			sessionTitle: "Auth token refresh")
		XCTAssertFalse(summary.isEmpty)
		XCTAssertFalse(summary.contains("\n"), "a spoken summary should be one line: \(summary)")
	}
}

extension OperatorBrainTests {
	/// The instructions are re-read every turn with no prompt cache, so they
	/// have to stay small. Naming this machine's skills in them cost 12.4
	/// seconds a turn against 1.4 without; they live behind list_skills now.
	@MainActor
	func testAPlainTurnIsFast() async throws {
		let brain = try brain()
		_ = try await brain.send("Hello")  // warm the model
		let clock = Date()
		_ = try await brain.send("Reply with exactly: ready")
		let elapsed = Date().timeIntervalSince(clock)
		XCTAssertLessThan(elapsed, 10, "a plain turn took \(elapsed)s; something is bloating the prompt again")
	}

	/// Skills are discoverable even though they are not named up front.
	@MainActor
	func testItCanFindASkillItWasNeverToldAbout() async throws {
		let brain = try brain()
		let reply = try await brain.send("Is there a skill for writing a handoff?")
		XCTAssertTrue(
			reply.localizedCaseInsensitiveContains("handoff"),
			"the operator could not find the handoff skill: \(reply)")
	}
}

extension OperatorBrainTests {
	/// A tool that throws ends the turn with nothing said. A small model guesses
	/// session ids from a vague question, so an invented one has to come back as
	/// a sentence it can act on, not an exception. This exact question used to
	/// kill the turn with a ToolCallError wrapping a 404.
	@MainActor
	func testAVagueQuestionStillGetsAnAnswer() async throws {
		let brain = try brain()
		let reply = try await brain.send("What was the last message from the last session?")
		XCTAssertFalse(reply.isEmpty, "a vague question got nothing back")
	}

	/// "What can you help me with?" used to answer with a list of skill names,
	/// which is what the sessions can run, not what the operator does.
	@MainActor
	func testItDescribesItselfRatherThanListingSkills() async throws {
		let brain = try brain()
		let reply = try await brain.send("What can you help me with?")
		XCTAssertTrue(
			reply.localizedCaseInsensitiveContains("session"),
			"the operator did not describe what it does: \(reply)")
		// The giveaway that it dumped the skill catalogue instead.
		XCTAssertFalse(
			reply.localizedCaseInsensitiveContains("address-feedback")
				|| reply.localizedCaseInsensitiveContains("agent-browser"),
			"the operator listed skill names instead of its own abilities: \(reply)")
	}
}

extension OperatorBrainTests {
	/// The on-device model's whole context is 4,096 tokens. A session's latest
	/// reply is routinely longer than that on its own, and a machine with
	/// seventy sessions spends a third of the window just listing them. Four
	/// follow-ups on the same thread used to end in "Provided 4,099 tokens, but
	/// the maximum allowed is 4,096" with nothing said.
	@MainActor
	func testAThreadOfFollowUpsDoesNotFillTheWindow() async throws {
		let brain = try brain()
		for question in [
			"What was the last message from the last session?",
			"The last one",
			"What about the deck",
			"Deck enhancements",
		] {
			let reply = try await brain.send(question)
			XCTAssertFalse(reply.isEmpty, "\(question) got nothing back")
			XCTAssertFalse(
				reply.contains("maximum allowed"),
				"the context window overflowed on \"\(question)\": \(reply)")
		}
	}
}

extension OperatorBrainTests {
	/// Telling the model a fixed sentence for "what can you do" made it answer
	/// *every* question that mentioned sessions with that sentence: "what are my
	/// sessions doing?" got the list of abilities instead of the sessions. A
	/// question about the sessions has to reach a tool.
	@MainActor
	func testAQuestionAboutTheSessionsIsAnswered() async throws {
		let brain = try brain()
		let canned = "I can tell you what your sessions are doing"
		for question in [
			"Can you catch me up on what's been happening in the sessions?",
			"What are my sessions doing?",
		] {
			let reply = try await brain.send(question)
			XCTAssertFalse(reply.isEmpty, "\(question) got nothing back")
			XCTAssertFalse(
				reply.hasPrefix(canned),
				"\"\(question)\" got the what-can-you-do sentence instead of an answer: \(reply)")
		}
	}

	/// The other half: asking what it can do still gets the sentence, not a tool
	/// call and not a session list.
	@MainActor
	func testAskingWhatItCanDoStillGetsTheSummary() async throws {
		let brain = try brain()
		let reply = try await brain.send("What can you help me with?")
		XCTAssertTrue(
			reply.localizedCaseInsensitiveContains("read or summarise"),
			"asking what it can do should describe its abilities: \(reply)")
	}
}
