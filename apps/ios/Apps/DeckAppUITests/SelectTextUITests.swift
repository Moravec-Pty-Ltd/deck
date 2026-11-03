import XCTest

/// Long-press a bubble, Select Text, copy one word: only that word reaches
/// the clipboard. Checked by pasting into the composer. Needs the fixture's
/// "Yolo badge in session header".
final class SelectTextUITests: XCTestCase {
	override func setUp() {
		continueAfterFailure = false
	}

	func testSelectPartOfAReplyAndOfAUserMessage() throws {
		let app = try FoldableUITests.launch(environment: [:])
		app.buttons["Sessions"].firstMatch.tap()
		let row = FoldableUITests.listItem("Yolo badge in session header", in: app)
		XCTAssertTrue(row.waitForExistence(timeout: 20), "needs the fixture sessions\n\(app.debugDescription.prefix(3000))")
		row.tap()

		let reply = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Done. The yolo badge'")).firstMatch
		copyFirstWord(of: reply, app)
		let field = app.textViews["sessionComposer"]
		paste(into: field, app)
		let pasted = expectation(for: NSPredicate(format: "value CONTAINS 'Done' AND NOT (value CONTAINS 'yolo badge shows')"), evaluatedWith: field)
		XCTAssertEqual(XCTWaiter.wait(for: [pasted], timeout: 5), .completed, "only the selected word, got \(String(describing: field.value))")

		let user = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Add a yolo badge'")).firstMatch
		copyFirstWord(of: user, app)
		paste(into: field, app)
		let pastedUser = expectation(for: NSPredicate(format: "value CONTAINS 'Add' AND NOT (value CONTAINS 'bypassPermissions')"), evaluatedWith: field)
		XCTAssertEqual(XCTWaiter.wait(for: [pastedUser], timeout: 5), .completed, "only the selected word, got \(String(describing: field.value))")

		// Tool output, whose text is itself selectable, still opens the menu.
		app.buttons["sessionMenu"].tap()
		let thread = app.buttons["Thread"]
		XCTAssertTrue(thread.waitForExistence(timeout: 5))
		thread.tap()
		// Edit hides its output, so the one to show is the Bash card's.
		let show = app.buttons.matching(NSPredicate(format: "label CONTAINS 'show output'")).firstMatch
		XCTAssertTrue(show.waitForExistence(timeout: 10), "\(app.debugDescription.prefix(3000))")
		show.tap()
		let output = app.staticTexts["svelte-check found 0 errors and 0 warnings"]
		XCTAssertTrue(output.waitForExistence(timeout: 5), "\(app.debugDescription.prefix(3000))")
		output.press(forDuration: 1.2)
		let select = app.buttons["Select Text"]
		XCTAssertTrue(select.waitForExistence(timeout: 5), "no Select Text on tool output\n\(app.debugDescription.prefix(3000))")
		select.tap()
		let sheet = app.textViews["selectText"]
		XCTAssertTrue(sheet.waitForExistence(timeout: 5))
		XCTAssertEqual(sheet.value as? String, "svelte-check found 0 errors and 0 warnings")
	}

	private func copyFirstWord(of bubble: XCUIElement, _ app: XCUIApplication) {
		XCTAssertTrue(bubble.waitForExistence(timeout: 20), "\(app.debugDescription.prefix(3000))")
		bubble.press(forDuration: 1.2)
		let select = app.buttons["Select Text"]
		XCTAssertTrue(select.waitForExistence(timeout: 5), "no Select Text in the menu\n\(app.debugDescription.prefix(3000))")
		select.tap()
		let text = app.textViews["selectText"]
		XCTAssertTrue(text.waitForExistence(timeout: 5), "\(app.debugDescription.prefix(3000))")
		// A double tap on the first word selects just that word.
		text.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 22, dy: 28)).doubleTap()
		let copy = app.menuItems["Copy"]
		XCTAssertTrue(copy.waitForExistence(timeout: 5), "no Copy in the edit menu\n\(app.debugDescription.prefix(3000))")
		let shot = XCTAttachment(screenshot: app.screenshot())
		shot.name = "select-text"
		shot.lifetime = .keepAlways
		add(shot)
		copy.tap()
		app.buttons["Done"].tap()
		XCTAssertTrue(text.waitForNonExistence(timeout: 5))
	}

	private func paste(into field: XCUIElement, _ app: XCUIApplication) {
		XCTAssertTrue(field.waitForExistence(timeout: 10))
		field.tap()
		field.press(forDuration: 1.2)
		let item = app.menuItems["Paste"]
		XCTAssertTrue(item.waitForExistence(timeout: 5), "no Paste in the edit menu\n\(app.debugDescription.prefix(3000))")
		item.tap()
	}
}
