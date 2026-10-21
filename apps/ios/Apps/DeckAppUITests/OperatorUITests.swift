import XCTest

/// The Operator tab: a typed question gets a spoken-style reply, and turning
/// the operator on brings up the voice bar and the wake-word state. The
/// thinking happens on the device, so this needs Apple Intelligence available
/// as well as a deck to ask about.
///
/// It asks a real question rather than telling the operator to repeat a phrase:
/// the on-device model refuses a "reply with exactly ..." instruction outright
/// ("I cannot fulfill that request"), where the server model it replaced would
/// have parroted it.
final class OperatorUITests: XCTestCase {
	override func setUp() {
		continueAfterFailure = false
	}

	func testTypedQuestionAndTurningOn() throws {
		let app = try FoldableUITests.launch(environment: [:])
		app.buttons["Operator"].firstMatch.tap()
		XCTAssertTrue(app.navigationBars["Operator"].waitForExistence(timeout: 10))
		// The on-device model needs iOS 26 and Apple Intelligence; without it the
		// tab says why and the switch stays off, which is not this test's subject.
		let turnOn = app.buttons["Turn the operator on"]
		XCTAssertTrue(turnOn.waitForExistence(timeout: 10))
		guard turnOn.isEnabled else { throw XCTSkip("the operator's on-device model is not available on this simulator") }

		let field = app.textFields["Or type to the operator"]
		XCTAssertTrue(field.waitForExistence(timeout: 10))
		field.tap()
		// The keyboard covers the tab bar; the composer's own button brings it back.
		let hide = app.buttons["Hide the keyboard"]
		XCTAssertTrue(hide.waitForExistence(timeout: 5), "the composer should offer a way to hide the keyboard\n\(app.debugDescription.prefix(2000))")
		hide.tap()
		XCTAssertTrue(app.buttons["Sessions"].firstMatch.waitForExistence(timeout: 5))
		XCTAssertTrue(app.buttons["Sessions"].firstMatch.isHittable, "the tab bar should be reachable once the keyboard is down")
		field.tap()
		let question = "What sessions are running right now?"
		field.typeText(question)
		app.buttons["Send to the operator"].tap()
		// Any bubble that is not the question echoed back: the operator had to
		// call list_sessions against deck to say anything at all. Filtered in
		// Swift because XCUITest predicates have no way to test a label's length.
		let answer = OperatorUITests.waitForReply(in: app, to: question, timeout: 120)
		XCTAssertNotNil(answer, "the operator should answer\n\(app.debugDescription.prefix(3000))")
		XCTAssertFalse(
			answer?.localizedCaseInsensitiveContains("cannot") ?? false,
			"the operator refused a question it should be able to answer: \(answer ?? "")")

		app.buttons["Turn the operator on"].tap()
		let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.buttons["OK"]
		if allow.waitForExistence(timeout: 5) { allow.tap() }
		XCTAssertTrue(app.buttons["Hold to talk"].waitForExistence(timeout: 20), "the voice bar should appear\n\(app.debugDescription.prefix(3000))")
		let state = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Listening for' OR label BEGINSWITH 'Speech recognition is off' OR label BEGINSWITH 'Awake'")).firstMatch
		XCTAssertTrue(state.waitForExistence(timeout: 10), "the wake state should show\n\(app.debugDescription.prefix(3000))")
		app.buttons["Turn the operator off"].tap()
		XCTAssertFalse(app.buttons["Hold to talk"].waitForExistence(timeout: 3))
	}

	/// The operator's reply, once one lands: the first bubble that is neither
	/// the question echoed back nor the empty-state hint.
	private static func waitForReply(in app: XCUIApplication, to question: String, timeout: TimeInterval) -> String? {
		let deadline = Date().addingTimeInterval(timeout)
		while Date() < deadline {
			for text in app.staticTexts.allElementsBoundByIndex {
				let label = text.label
				guard label.count > 15,
					!label.hasPrefix(String(question.prefix(20))),
					!label.hasPrefix("Turn it on"),
					label != "Operator"
				else { continue }
				return label
			}
			_ = app.staticTexts.firstMatch.waitForExistence(timeout: 2)
		}
		return nil
	}
}
