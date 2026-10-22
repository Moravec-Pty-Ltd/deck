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
		let row = FoldableUITests.listItem("Yolo badge in session header", in: app)
		XCTAssertTrue(row.waitForExistence(timeout: 20), "needs the fixture sessions\n\(app.debugDescription.prefix(3000))")
		row.tap()

		// Chat (the default) folds runs of tool calls into one summary row;
		// Thread shows every card by name. The choice lives in the session menu.
		let menu = app.buttons["sessionMenu"]
		XCTAssertTrue(menu.waitForExistence(timeout: 20))
		XCTAssertFalse(app.segmentedControls.buttons["Thread"].exists, "no Chat / Thread row above the transcript")
		let composer = XCTAttachment(screenshot: app.screenshot())
		composer.name = "session-composer"
		composer.lifetime = .keepAlways
		add(composer)
		menu.tap()
		let thread = app.buttons["Thread"]
		XCTAssertTrue(thread.waitForExistence(timeout: 5), "the session menu offers Thread\n\(app.debugDescription.prefix(3000))")
		let menuShot = XCTAttachment(screenshot: app.screenshot())
		menuShot.name = "session-menu"
		menuShot.lifetime = .keepAlways
		add(menuShot)
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

		// Back to Chat from the same menu, so later tests start from the default.
		menu.tap()
		let chat = app.buttons["Chat"]
		XCTAssertTrue(chat.waitForExistence(timeout: 5))
		chat.tap()
		XCTAssertEqual(app.state, .runningForeground)
	}

	/// The PR is one row: a tap opens its menu, a work session's review only
	/// comments, a ready PR merges from the row, and a sideways swipe
	/// dismisses it without tapping anything.
	func testThePRRowOpensItsMenuAndSwipesAway() throws {
		let app = try FoldableUITests.launch(environment: [:])
		app.buttons["Sessions"].firstMatch.tap()
		let row = FoldableUITests.listItem("Stream token diff renderer", in: app)
		XCTAssertTrue(row.waitForExistence(timeout: 20))
		row.tap()
		let prRow = app.buttons["prRow"]
		XCTAssertTrue(prRow.waitForExistence(timeout: 20), "needs the fixture's PR on 'Stream token diff renderer'\n\(app.debugDescription.prefix(3000))")
		XCTAssertLessThan(prRow.frame.height, 60, "the PR header is one line")
		XCTAssertTrue(prRow.label.contains("Stream token diffs"), "the row shows the PR title: \(prRow.label)")
		let shot = XCTAttachment(screenshot: app.screenshot())
		shot.name = "session-with-pr"
		shot.lifetime = .keepAlways
		add(shot)

		prRow.tap()
		let review = app.buttons["prReview"]
		XCTAssertTrue(review.waitForExistence(timeout: 5), "a tap opens the PR menu")
		XCTAssertTrue(app.buttons["prDismiss"].exists)
		review.tap()
		XCTAssertTrue(app.navigationBars["Comment"].waitForExistence(timeout: 5), "a work session's review only comments")
		XCTAssertFalse(app.buttons["Approve"].exists)
		app.buttons["Cancel"].tap()

		let merge = app.buttons["prMerge"]
		XCTAssertTrue(merge.waitForExistence(timeout: 5), "a ready PR merges from the row")
		merge.tap()
		XCTAssertTrue(app.navigationBars.matching(NSPredicate(format: "identifier BEGINSWITH 'Merge'")).firstMatch.waitForExistence(timeout: 5))
		app.buttons["Cancel"].tap()

		// Started on the menu, the harder case: a swipe must win over its tap.
		XCTAssertTrue(prRow.waitForExistence(timeout: 5))
		prRow.swipeLeft()
		XCTAssertTrue(prRow.waitForNonExistence(timeout: 10), "the swipe should dismiss the PR")
		XCTAssertFalse(review.exists, "a swipe must not open the PR menu")
	}

	/// While a turn runs, Stop sits in the working row above the composer, not
	/// in the navigation bar, and stops the turn.
	func testStopSitsInTheWorkingRow() throws {
		guard let url = ProcessInfo.processInfo.environment["DECK_UITEST_URL"],
			let token = ProcessInfo.processInfo.environment["DECK_UITEST_TOKEN"]
		else { throw XCTSkip("set DECK_UITEST_URL and DECK_UITEST_TOKEN to run the UI tests") }
		let app = try FoldableUITests.launch(environment: [:])
		app.buttons["Sessions"].firstMatch.tap()
		let row = FoldableUITests.listItem("Stream token diff renderer", in: app)
		XCTAssertTrue(row.waitForExistence(timeout: 20))
		row.tap()
		XCTAssertTrue(app.textViews["sessionComposer"].waitForExistence(timeout: 20))

		let sessionId = try VoiceUITests.sessionId(titled: "Stream token diff renderer", url: url, token: token)
		addTeardownBlock { try? VoiceUITests.stop(sessionId: sessionId, url: url, token: token) }
		// [slow] holds the fixture's fake claude in its turn until stopped.
		try VoiceUITests.send("[slow] Count slowly from one to twelve.", sessionId: sessionId, url: url, token: token)

		XCTAssertTrue(app.staticTexts["Working…"].waitForExistence(timeout: 30), "no working row\n\(app.debugDescription.prefix(3000))")
		let stop = app.buttons["Stop"]
		XCTAssertTrue(stop.waitForExistence(timeout: 5), "the working row has no Stop")
		XCTAssertFalse(app.navigationBars.buttons["Stop"].exists, "Stop is no longer in the navigation bar")
		XCTAssertLessThan(stop.frame.maxY, app.textViews["sessionComposer"].frame.minY, "Stop sits above the composer")
		stop.tap()
		XCTAssertTrue(app.staticTexts["Working…"].waitForNonExistence(timeout: 30), "Stop should end the turn")
	}
}
