import XCTest

/// Opens a session and checks the transcript renders agent work (tool cards),
/// not just chat text. Needs the fixture's "Yolo badge in session header".
final class TranscriptUITests: XCTestCase {
	override func setUp() {
		continueAfterFailure = false
	}

	func testSessionTranscriptShowsToolCards() throws {
		let app = try FoldableUITests.launch(environment: [:])
		app.buttons["Sessions"].firstMatch.tap()
		// A session that has run tools, not whichever is newest: other tests
		// leave fresh sessions on top that have only chatted.
		let row = app.staticTexts["Yolo badge in session header"].firstMatch
		XCTAssertTrue(row.waitForExistence(timeout: 20), "needs the fixture sessions\n\(app.debugDescription.prefix(3000))")
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

		// Opens at the newest output, not the top of the recent window. Checked
		// on the reply itself: this transcript fits on one screen, so a scroll
		// bar's value says nothing.
		let newest = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Done. The yolo badge'")).firstMatch
		XCTAssertTrue(newest.waitForExistence(timeout: 10), "the newest reply is not rendered")
		XCTAssertTrue(newest.isHittable, "transcript should open at its newest output")

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
