import XCTest
import UIKit

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

	/// The field grows to five lines, then holds that height and scrolls;
	/// back under five it shrinks and stops scrolling, so a long press
	/// still offers Paste.
	func testSessionComposerStopsGrowingAtFiveLines() throws {
		let app = try FoldableUITests.launch(environment: [:])
		app.buttons["Sessions"].firstMatch.tap()
		let row = FoldableUITests.listItem("long transcript", in: app)
		XCTAssertTrue(row.waitForExistence(timeout: 20))
		row.tap()

		let field = app.textViews["sessionComposer"]
		XCTAssertTrue(field.waitForExistence(timeout: 20))
		// Another test in this session may have left a draft.
		clear(field, app)
		let one = field.frame.height
		field.typeText("one\ntwo\nthree\nfour")
		let four = field.frame.height
		field.typeText("\nfive\nsix")
		let capped = field.frame.height
		XCTAssertGreaterThan(capped, four, "the field did not grow past four lines")
		XCTAssertEqual(capped, one * 5, accuracy: 3, "the cap is not five lines")
		field.typeText("\nseven\neight\nnine")
		XCTAssertTrue(waitFor { abs(field.frame.height - capped) <= 1 }, "the field kept growing past five lines")

		field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: "\nthree\nfour\nfive\nsix\nseven\neight\nnine".count))
		XCTAssertEqual(field.value as? String, "one\ntwo")
		XCTAssertTrue(waitFor { field.frame.height < four }, "the field did not shrink")
		// Paste only shows with something on the clipboard.
		UIPasteboard.general.string = "pasted"
		field.press(forDuration: 1.2)
		XCTAssertTrue(app.menuItems["Paste"].waitForExistence(timeout: 5), "no Paste in the edit menu once the field fits again")
		app.menuItems["Paste"].tap()
		XCTAssertTrue(waitFor { (field.value as? String ?? "").hasSuffix("pasted") }, "the paste did not land")

		// A long paste lands at the cap, not past it.
		clear(field, app)
		UIPasteboard.general.string = (1...12).map { "paragraph \($0) of a long pasted message" }.joined(separator: "\n\n")
		field.press(forDuration: 1.2)
		XCTAssertTrue(app.menuItems["Paste"].waitForExistence(timeout: 5))
		app.menuItems["Paste"].tap()
		XCTAssertTrue(waitFor { (field.value as? String ?? "").hasSuffix("paragraph 12 of a long pasted message") })
		XCTAssertTrue(waitFor { abs(field.frame.height - capped) <= 1 }, "a long paste did not land at the cap")
		// The draft outlives the test.
		clear(field, app)
	}

	/// The field is one line tall; a tap anywhere else in the composer's box
	/// still focuses it, and with text in it the caret goes to the end.
	func testTapInComposerPaddingFocusesField() throws {
		let app = try FoldableUITests.launch(environment: [:])
		app.buttons["Sessions"].firstMatch.tap()
		let row = FoldableUITests.listItem("long transcript", in: app)
		XCTAssertTrue(row.waitForExistence(timeout: 20))
		row.tap()

		let field = app.textViews["sessionComposer"]
		XCTAssertTrue(field.waitForExistence(timeout: 20))
		XCTAssertFalse(hasFocus(field))
		// A button in the composer does its own thing without taking focus first.
		app.buttons["Quick messages"].tap()
		XCTAssertTrue(app.buttons["Manage…"].waitForExistence(timeout: 5), "the quick messages menu did not open")
		XCTAssertFalse(hasFocus(field))
		app.scrollViews["transcript"].tap()
		XCTAssertTrue(waitFor { !app.buttons["Manage…"].exists })
		// Inside the composer's 12-point padding, past the field's top-left corner.
		tap(app, at: CGPoint(x: field.frame.minX - 6, y: field.frame.minY - 6))
		XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10), "no keyboard came up")
		XCTAssertTrue(hasFocus(field))

		field.typeText("first")
		// The caret to the start, so ending up at the end is the tap's doing.
		field.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0.5)).tap()
		app.scrollViews["transcript"].tap()
		XCTAssertTrue(waitFor { !hasFocus(field) }, "the transcript tap did not leave the field")
		// The gap between the field and the button row.
		tap(app, at: CGPoint(x: field.frame.midX, y: field.frame.maxY + 5))
		XCTAssertTrue(waitFor { hasFocus(field) })
		field.typeText(" last")
		// The draft may already hold text from another test in this session.
		let typed = field.value as? String ?? ""
		XCTAssertTrue(typed.hasSuffix("first last"), "the caret was not at the end: \(typed)")
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

	/// Empties the field: focused from the composer's padding, so the caret is at the end.
	private func clear(_ field: XCUIElement, _ app: XCUIApplication) {
		// The first tap may only close an open edit menu.
		app.scrollViews["transcript"].tap()
		if !waitFor({ !hasFocus(field) }) { app.scrollViews["transcript"].tap() }
		XCTAssertTrue(waitFor { !hasFocus(field) }, "the transcript tap did not leave the field")
		tap(app, at: CGPoint(x: field.frame.minX - 6, y: field.frame.minY - 6))
		XCTAssertTrue(waitFor { hasFocus(field) })
		for _ in 0..<20 where !(field.value as? String ?? "").isEmpty {
			field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 50))
		}
		XCTAssertEqual(field.value as? String ?? "", "", "the draft did not clear")
	}

	private func hasFocus(_ element: XCUIElement) -> Bool {
		element.value(forKey: "hasKeyboardFocus") as? Bool ?? false
	}

	private func tap(_ app: XCUIApplication, at point: CGPoint) {
		app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: point.x, dy: point.y)).tap()
	}

	private func waitFor(_ condition: () -> Bool) -> Bool {
		for _ in 0..<20 {
			if condition() { return true }
			usleep(250_000)
		}
		return false
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
