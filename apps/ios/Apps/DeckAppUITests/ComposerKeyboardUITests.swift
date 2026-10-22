import XCTest

/// What you type stays visible above the keyboard, in a session's composer
/// and on the Operator tab, including a draft long enough to wrap. Needs the
/// demo-fixture server (a session titled "long transcript").
final class ComposerKeyboardUITests: XCTestCase {
	private let draft = "Can you also write this up in layman terms and put it in as a linear issue for me please, with the runbook attached"

	override func setUp() {
		continueAfterFailure = false
	}

	func testSessionComposerStaysVisible() throws {
		let app = try FoldableUITests.launch(environment: [:])
		app.buttons["Sessions"].firstMatch.tap()
		let row = FoldableUITests.listItem("long transcript", in: app)
		XCTAssertTrue(row.waitForExistence(timeout: 20))
		row.tap()

		let field = app.textViews["sessionComposer"]
		XCTAssertTrue(field.waitForExistence(timeout: 20))
		field.tap()
		field.typeText(draft)
		assertVisibleAboveKeyboard(app, id: "sessionComposer", what: "the session composer")
	}

	func testOperatorComposerStaysVisible() throws {
		let app = try FoldableUITests.launch(environment: [:])
		app.buttons["Operator"].firstMatch.tap()
		let field = app.textFields["Or type to the operator"]
		XCTAssertTrue(field.waitForExistence(timeout: 20))
		field.tap()
		field.typeText(draft)
		assertVisibleAboveKeyboard(app, id: "operatorComposer", what: "the operator composer")
	}

	/// The field must sit entirely above the keyboard, and nothing may cover
	/// it: a floating keyboard accessory that overlaps counts as covering. A
	/// field that has grown past one line is a text view, and its label is the
	/// text typed into it, so it is found by what it holds rather than by name.
	private func assertVisibleAboveKeyboard(_ app: XCUIApplication, id: String, what: String) {
		sleep(2)
		let keyboard = app.keyboards.firstMatch
		XCTAssertTrue(keyboard.waitForExistence(timeout: 10), "no keyboard came up")
		let field = app.descendants(matching: .any)[id]
		XCTAssertTrue(field.waitForExistence(timeout: 5), "\(what) disappeared")
		XCTAssertLessThanOrEqual(
			field.frame.maxY, keyboard.frame.minY + 1,
			"\(what) (\(field.frame)) must sit above the keyboard (\(keyboard.frame))")
		for overlap in app.buttons.allElementsBoundByIndex where overlap.isHittable && overlap.frame.intersects(field.frame) {
			XCTFail("\(overlap.label) at \(overlap.frame) covers \(what) at \(field.frame)")
		}
	}
}
