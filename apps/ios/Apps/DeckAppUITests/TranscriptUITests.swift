import XCTest

/// Opens a live session and checks the transcript renders agent work (tool
/// cards), not just chat text. Needs a running deck: see SwipeDeleteUITests.
final class TranscriptUITests: XCTestCase {
	override func setUp() {
		continueAfterFailure = false
	}

	func testSessionTranscriptShowsToolCards() throws {
		guard let url = ProcessInfo.processInfo.environment["DECK_UITEST_URL"],
			let token = ProcessInfo.processInfo.environment["DECK_UITEST_TOKEN"]
		else { throw XCTSkip("set DECK_UITEST_URL and DECK_UITEST_TOKEN to run the UI tests") }

		let app = XCUIApplication()
		app.launch()
		let manual = app.buttons["Enter details manually"]
		if manual.waitForExistence(timeout: 5) {
			manual.tap()
			let urlField = app.textFields["Server URL"]
			XCTAssertTrue(urlField.waitForExistence(timeout: 5))
			urlField.tap()
			urlField.typeText(url)
			let tokenField = app.secureTextFields["Token"]
			tokenField.tap()
			tokenField.typeText(token)
			app.buttons["Connect"].tap()
		}
		XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 20))
		app.tabBars.buttons["Sessions"].tap()

		let list = app.collectionViews.firstMatch
		XCTAssertTrue(list.waitForExistence(timeout: 20))
		let row = list.cells.element(boundBy: 0)
		XCTAssertTrue(row.waitForExistence(timeout: 20))
		row.tap()

		// Chat (the default) folds runs of tool calls into one summary row;
		// Thread shows every card by name.
		let thread = app.buttons["Thread"]
		XCTAssertTrue(thread.waitForExistence(timeout: 20))
		thread.tap()

		// A worked session shows tool cards; every agent session runs something.
		let toolNames = ["Bash", "Read", "Edit", "Write", "Grep", "Glob", "Task", "TodoWrite"]
		let anyTool = NSPredicate(format: "label IN %@", toolNames)
		let found = app.staticTexts.matching(anyTool).firstMatch
		if !found.waitForExistence(timeout: 25) {
			XCTFail("no tool cards rendered in the transcript\n\(app.debugDescription)")
		}
		XCTAssertEqual(app.state, .runningForeground)

		// Opens at the newest output, not the top of the recent window.
		let scrollBar = app.otherElements.matching(
			NSPredicate(format: "label BEGINSWITH 'Vertical scroll bar'")).firstMatch
		if scrollBar.waitForExistence(timeout: 5), let value = scrollBar.value as? String {
			XCTAssertNotEqual(value, "0%", "transcript should open scrolled to the bottom")
		}

		// A long session offers older history above the recent window; nearing
		// the top pulls it in on its own, and the transcript must stay readable
		// (no crash, rows still there) while it lands.
		let scroller = app.scrollViews.firstMatch
		for _ in 0..<12 where !app.buttons["Load earlier"].exists {
			scroller.swipeDown(velocity: .fast)
		}
		if app.buttons["Load earlier"].exists || app.progressIndicators.firstMatch.exists {
			scroller.swipeDown(velocity: .fast)
			sleep(3)
			XCTAssertTrue(found.waitForExistence(timeout: 10))
		}
		XCTAssertEqual(app.state, .runningForeground)
	}
}
