import XCTest
@testable import DeckKit

final class OperatorConsentTests: XCTestCase {
	private actor Log {
		var ran: [String] = []
		func add(_ s: String) { ran.append(s) }
	}

	func testRunsTheHeldActionsOnAYes() async {
		let consent = OperatorConsent()
		let log = Log()
		_ = await consent.hold("send \"run the tests\" to Auth") { await log.add("auth"); return "Sent to Auth." }
		_ = await consent.hold("send \"run the tests\" to Billing") { await log.add("billing"); return "Sent to Billing." }
		let question = await consent.question()
		XCTAssertEqual(question, "Shall I send \"run the tests\" to Auth, and send \"run the tests\" to Billing?")
		let result = await consent.answer("yes please")
		XCTAssertEqual(result, "Sent to Auth. Sent to Billing.")
		let ran = await log.ran
		XCTAssertEqual(ran, ["auth", "billing"])
		// Used up.
		let again = await consent.answer("yes")
		XCTAssertNil(again)
	}

	func testAnythingButAYesDropsThem() async {
		let consent = OperatorConsent()
		let log = Log()
		_ = await consent.hold("start a session in acme") { await log.add("start"); return "Started." }
		let result = await consent.answer("what is the review session doing")
		XCTAssertNil(result)
		let later = await consent.answer("yes")
		XCTAssertNil(later)
		let ran = await log.ran
		XCTAssertEqual(ran, [])
		let question = await consent.question()
		XCTAssertNil(question)
	}

	func testAskedOnceForTheSameActionAndDroppedOnRequest() async {
		let consent = OperatorConsent()
		_ = await consent.hold("stop nothing") { "ran" }
		_ = await consent.hold("stop nothing") { "ran" }
		let question = await consent.question()
		XCTAssertEqual(question, "Shall I stop nothing?")
		await consent.drop()
		let result = await consent.answer("yes")
		XCTAssertNil(result)
	}

	func testHoldsAtMostThree() async {
		let consent = OperatorConsent()
		for n in 1...3 { _ = await consent.hold("send \"\(n)\" to Auth") { "ran" } }
		let fourth = await consent.hold("send \"4\" to Auth") { "ran" }
		XCTAssertTrue(fourth.hasPrefix("Not held"))
	}

	func testRefusesWhatIsTooLongToReadOutWhole() async {
		let consent = OperatorConsent()
		let reply = await consent.hold("send \"" + String(repeating: "x", count: 400) + "\" to Auth") { "ran" }
		XCTAssertTrue(reply.hasPrefix("Not held"))
		let question = await consent.question()
		XCTAssertNil(question)
	}

	func testWhatCountsAsYes() {
		let yes = ["Yes.", "yeah go ahead", "OK", "sure", "go ahead", "do it", "please do it", "confirmed", "yes please", "go for it", "send it", "sounds good"]
		for text in yes {
			XCTAssertTrue(OperatorConsent.isYes(text), text)
		}
		let notYes = [
			"", "please", "no", "yes, but don\u{2019}t send it", "yes but don't send it", "what did it say", "wait", "not yet",
			"please stop", "do you think that's right", "do nothing", "go back to auth", "ok what's the message",
			"yes what is that", "sure, what will it send", "yes send something else", "yes 2"
		]
		for text in notYes {
			XCTAssertFalse(OperatorConsent.isYes(text), text)
		}
	}
}
