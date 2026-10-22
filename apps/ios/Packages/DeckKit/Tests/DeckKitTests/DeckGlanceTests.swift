import XCTest
@testable import DeckKit

final class DeckGlanceTests: XCTestCase {
	private let now = Date(timeIntervalSince1970: 1_000)

	private func session(_ id: String, _ status: String, title: String) throws -> SessionDigest {
		try JSONDecoder().decode(SessionDigest.self, from: Data(#"{"id": "\#(id)", "status": "\#(status)", "title": "\#(title)"}"#.utf8))
	}

	private func question(_ labels: [String], multi: Bool? = nil) -> AskQuestion {
		AskQuestion(question: "Which colour?", header: "Colour", multiSelect: multi, options: labels.map { AskOption(label: $0) })
	}

	func testCountsAndFirstQuestionWithButtons() throws {
		let digest = MenuBarDigest(
			asks: [
				DeckAsk(sessionId: "c_1", askId: "toolu_1", questions: [question(["Red", "Blue"])]),
				DeckAsk(sessionId: "r_2", runId: "r_2", questions: [AskQuestion(question: "Retry?")])
			],
			sessions: [try session("c_1", "running", title: "Fix login"), try session("c_3", "running", title: "Docs")],
			runs: [])
		let glance = DeckGlance(digest, at: now)
		XCTAssertEqual([glance.questions, glance.blockedRuns, glance.running], [1, 1, 1])
		XCTAssertEqual(glance.first?.title, "Fix login")
		XCTAssertEqual(glance.first?.question, "Which colour?")
		XCTAssertEqual(glance.first?.options, ["Red", "Blue"])
		XCTAssertEqual(glance.url, URL(string: "deck://s/c_1"))
		XCTAssertEqual(glance.fetchedAt, now)
	}

	func testAnswerPostsTheNotificationsStructuredAnswer() throws {
		let digest = MenuBarDigest(
			asks: [DeckAsk(sessionId: "c_1", askId: "toolu_1", questions: [question(["Red", "Blue"])])],
			sessions: [], runs: [])
		let glance = DeckGlance(digest, at: now)
		let answer = try XCTUnwrap(glance.answer("Blue"))
		XCTAssertEqual(answer.sessionId, "c_1")
		XCTAssertEqual(answer.askId, "toolu_1")
		XCTAssertEqual(answer.text, "Answering your question:\n- Colour: Blue")
		XCTAssertTrue(answer.structured)
		XCTAssertNil(glance.answer("Green"))
	}

	func testNoButtonsWhenOneTapCannotAnswer() {
		let tooMany = DeckAsk(sessionId: "c_1", askId: "t", questions: [question(["A", "B", "C", "D"])])
		let multi = DeckAsk(sessionId: "c_1", askId: "t", questions: [question(["A", "B"], multi: true)])
		let free = DeckAsk(sessionId: "c_1", questions: [AskQuestion(question: "Why?")])
		let unmatched = DeckAsk(sessionId: "c_1", questions: [question(["A", "B"])])
		for ask in [tooMany, multi, free, unmatched] {
			let glance = DeckGlance(MenuBarDigest(asks: [ask], sessions: [], runs: []), at: now)
			XCTAssertEqual(glance.first?.options, [])
			XCTAssertNil(glance.answer("A"))
			XCTAssertEqual(glance.url, URL(string: "deck://s/c_1"))
		}
	}

	func testBlockedRunWithoutSessionOpensTheApp() {
		let glance = DeckGlance(
			MenuBarDigest(asks: [DeckAsk(sessionId: "r_2", runId: "r_2", questions: [AskQuestion(question: "Retry?")])], sessions: [], runs: []),
			at: now)
		XCTAssertEqual(glance.first?.title, "Blocked run")
		XCTAssertNil(glance.first?.sessionId)
		XCTAssertNil(glance.url)
	}

	func testQuietAndRoundTrips() throws {
		let glance = DeckGlance(MenuBarDigest(asks: [], sessions: [try session("c_3", "running", title: "Docs")], runs: []), at: now)
		XCTAssertNil(glance.first)
		XCTAssertEqual(glance.running, 1)
		XCTAssertEqual(try JSONDecoder().decode(DeckGlance.self, from: JSONEncoder().encode(glance)), glance)
	}
}
