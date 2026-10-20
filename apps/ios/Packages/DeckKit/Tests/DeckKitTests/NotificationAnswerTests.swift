import XCTest
@testable import DeckKit

final class NotificationAnswerTests: XCTestCase {
	/// The userInfo as APNs delivers deck's payload (apns-core toApnsPayload).
	private func userInfo(_ json: String) throws -> [AnyHashable: Any] {
		try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [AnyHashable: Any])
	}

	/// deck's blocked-run push (workflow-runner announce()): no options, so the
	/// reply action carries the answer to the run.
	func testABlockedRunsReplyAnswersTheRun() throws {
		let info = try userInfo("""
		{ "aps": { "alert": { "title": "Run blocked · #7" }, "category": "DECK_ASK" }, "url": "/runs/r_1",
		  "ask": { "runId": "r_1", "header": "#7", "options": [], "questions": 1 } }
		""")
		let answer = try XCTUnwrap(NotificationAnswer(userInfo: info, optionSlot: nil, typed: " main \n"))
		XCTAssertEqual(answer.runId, "r_1")
		XCTAssertNil(answer.sessionId)
		XCTAssertEqual(answer.label, "main")
		XCTAssertNil(NotificationAnswer(userInfo: info, optionSlot: 0, typed: nil), "a run has no options to pick")
		XCTAssertNil(NotificationAnswer(userInfo: info, optionSlot: nil, typed: nil), "a plain tap opens the run")
	}

	func testASessionAskPicksTheNumberedOption() throws {
		let info = try userInfo("""
		{ "ask": { "sessionId": "c_1", "askId": "toolu_1", "header": "Colour", "options": ["Red", "Blue"], "questions": 1 } }
		""")
		let answer = try XCTUnwrap(NotificationAnswer(userInfo: info, optionSlot: 1, typed: nil))
		XCTAssertEqual(answer.sessionId, "c_1")
		XCTAssertNil(answer.runId)
		XCTAssertEqual(answer.askId, "toolu_1")
		XCTAssertEqual(answer.header, "Colour")
		XCTAssertEqual(answer.label, "Blue")
		XCTAssertTrue(answer.structured)
		XCTAssertNil(NotificationAnswer(userInfo: info, optionSlot: 2, typed: nil))
	}

	func testAMultiQuestionAskIsNotStructured() throws {
		let info = try userInfo(#"{ "ask": { "sessionId": "c_1", "options": [], "questions": 2 } }"#)
		let answer = try XCTUnwrap(NotificationAnswer(userInfo: info, optionSlot: nil, typed: "both"))
		XCTAssertFalse(answer.structured)
		XCTAssertEqual(answer.header, "Answer")
	}

	func testADeclinedAnswerShowsDecksReasonAlone() throws {
		let info = try userInfo(#"{ "ask": { "sessionId": "c_1", "header": "Colour", "options": ["Red"], "questions": 1 } }"#)
		let answer = try XCTUnwrap(NotificationAnswer(userInfo: info, optionSlot: 0, typed: nil))
		let declined = DeckError.answerDeclined(reason: "That question was already answered.")
		XCTAssertEqual(declined.localizedDescription, "That question was already answered.")
		XCTAssertEqual(DeckError.message(for: declined), "That question was already answered.")
		XCTAssertEqual(answer.failureBody(for: declined), "\"Red\": That question was already answered.")
		XCTAssertEqual(answer.failureBody(for: DeckError.http(status: 409, message: "Run is not blocked")), "\"Red\": Run is not blocked")
	}
}
