import XCTest
@testable import DeckKit

final class AskNotificationTests: XCTestCase {
	func testOptionActionsRoundTripTheirSlot() {
		for slot in 0..<AskNotification.optionSlots {
			XCTAssertEqual(AskNotification.optionSlot(AskNotification.optionAction(slot)), slot)
		}
		XCTAssertNil(AskNotification.optionSlot(AskNotification.replyAction))
		XCTAssertNil(AskNotification.optionSlot("com.apple.UNNotificationDefaultActionIdentifier"))
	}

	func testATapOpensTheRunOrTheSessionTheURLNames() {
		XCTAssertEqual(AskNotification.target(userInfo: ["url": "/runs/r_1"]), .run("r_1"))
		XCTAssertEqual(AskNotification.target(userInfo: ["url": "http://deck.test/s/c_1"]), .session("c_1"))
		XCTAssertEqual(AskNotification.target(userInfo: ["url": "http://deck.test/runs/r_1/s/c_9"]), .run("r_1"))
		XCTAssertNil(AskNotification.target(userInfo: ["url": "http://deck.test/projects"]))
		XCTAssertNil(AskNotification.target(userInfo: [:]))
	}

	func testAnAnswersTextAndFailureMatchTheAskCard() throws {
		let info: [AnyHashable: Any] = ["ask": ["sessionId": "c_1", "header": "Colour", "options": ["Red"], "questions": 1]]
		let answer = try XCTUnwrap(NotificationAnswer(userInfo: info, optionSlot: 0, typed: nil))
		XCTAssertEqual(answer.text, "Answering your question:\n- Colour: Red")
		XCTAssertEqual(answer.failureBody(for: DeckError.http(status: 409, message: "not blocked")), "\"Red\": not blocked")
	}
}
