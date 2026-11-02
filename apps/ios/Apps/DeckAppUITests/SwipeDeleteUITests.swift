import XCTest

/// Drives the real app against a running deck server. Point it at one with
/// `DECK_UITEST_URL` / `DECK_UITEST_TOKEN` (see the repo README); without them
/// the tests skip, so they never fail a machine that has no deck to talk to.
final class SwipeDeleteUITests: XCTestCase {
	override func setUp() {
		continueAfterFailure = false
	}

	/// Swiping a session row and tapping Delete must open the delete sheet with
	/// the app still alive. Cancels rather than confirming: this runs against a
	/// live deck and must not destroy real sessions.
	func testSwipeToDeleteOpensSheetWithoutCrashing() throws {
		let app = try signedInApp()

		let list = app.collectionViews.firstMatch
		XCTAssertTrue(list.waitForExistence(timeout: 20), "sessions list never appeared")
		let row = FoldableUITests.firstSessionRow(in: list)
		XCTAssertTrue(row.waitForExistence(timeout: 20), "no session rows to swipe")

		row.swipeLeft()
		let delete = app.buttons["Delete"]
		XCTAssertTrue(delete.waitForExistence(timeout: 5), "swipe did not reveal Delete")
		delete.tap()

		let sheetTitle = app.navigationBars["Delete session"]
		XCTAssertTrue(sheetTitle.waitForExistence(timeout: 5), "delete sheet did not open")
		XCTAssertEqual(app.state, .runningForeground, "app died presenting the delete sheet")

		app.buttons["Cancel"].tap()
		XCTAssertTrue(list.waitForExistence(timeout: 5))
		XCTAssertEqual(app.state, .runningForeground, "app died dismissing the delete sheet")
	}

	/// The same gesture repeated: a swipe that lands while the list is being
	/// reordered by incoming events is the case a single pass can miss.
	func testRepeatedSwipesStaySafe() throws {
		let app = try signedInApp()

		let list = app.collectionViews.firstMatch
		XCTAssertTrue(list.waitForExistence(timeout: 20))
		XCTAssertTrue(FoldableUITests.firstSessionRow(in: list).waitForExistence(timeout: 20))

		for index in 0..<6 {
			// Looked up afresh each time, as the list reorders; headers are cells too.
			let rows = list.cells.allElementsBoundByIndex.filter { $0.staticTexts.count > 1 }
			guard !rows.isEmpty else { continue }
			let row = rows[index % min(3, rows.count)]
			guard row.exists else { continue }
			row.swipeLeft()
			let delete = app.buttons["Delete"]
			if delete.waitForExistence(timeout: 3) {
				delete.tap()
				if app.navigationBars["Delete session"].waitForExistence(timeout: 3) {
					app.buttons["Cancel"].tap()
				}
			}
			XCTAssertEqual(app.state, .runningForeground, "app died on swipe \(index)")
		}
	}

	/// A session mid-turn warns in the delete sheet and names the stop on its
	/// button; an idle one keeps the plain sheet. Cancels, as above.
	func testDeletingARunningSessionWarns() throws {
		guard let url = ProcessInfo.processInfo.environment["DECK_UITEST_URL"],
			let token = ProcessInfo.processInfo.environment["DECK_UITEST_TOKEN"]
		else { throw XCTSkip("set DECK_UITEST_URL and DECK_UITEST_TOKEN to run the UI tests") }
		let app = try signedInApp()
		let title = "Stream token diff renderer"
		let sessionId = try VoiceUITests.sessionId(titled: title, url: url, token: token)
		addTeardownBlock { try? VoiceUITests.stop(sessionId: sessionId, url: url, token: token) }
		// [slow] holds the fixture's fake claude in its turn until stopped.
		try VoiceUITests.send("[slow] Count slowly from one to twelve.", sessionId: sessionId, url: url, token: token)

		let warning = app.staticTexts["This session is still working. Deleting it stops the current turn and any subagents, and the work in progress is lost."]
		let stopAndDelete = app.buttons["Stop and Delete"]
		// The row may not have heard of the turn yet; reopen until the sheet has.
		var warned = false
		for _ in 0..<10 where !warned {
			let row = FoldableUITests.listItem(title, in: app)
			XCTAssertTrue(row.waitForExistence(timeout: 20))
			row.swipeLeft()
			XCTAssertTrue(app.buttons["Delete"].waitForExistence(timeout: 5), "swipe did not reveal Delete")
			app.buttons["Delete"].tap()
			XCTAssertTrue(app.navigationBars["Delete session"].waitForExistence(timeout: 5), "delete sheet did not open")
			warned = warning.waitForExistence(timeout: 2)
			if !warned { app.buttons["Cancel"].tap() }
		}
		XCTAssertTrue(warned, "no in-progress warning\n\(app.debugDescription.prefix(3000))")
		XCTAssertTrue(stopAndDelete.exists, "the button should read Stop and Delete")
		let shot = XCTAttachment(screenshot: app.screenshot())
		shot.name = "delete-running"
		shot.lifetime = .keepAlways
		add(shot)
		app.buttons["Cancel"].tap()

		let idle = FoldableUITests.listItem("long transcript", in: app)
		XCTAssertTrue(idle.waitForExistence(timeout: 20))
		idle.swipeLeft()
		app.buttons["Delete"].tap()
		XCTAssertTrue(app.navigationBars["Delete session"].waitForExistence(timeout: 5))
		XCTAssertFalse(warning.exists, "an idle session gets no warning")
		XCTAssertFalse(stopAndDelete.exists)
		let idleShot = XCTAttachment(screenshot: app.screenshot())
		idleShot.name = "delete-idle"
		idleShot.lifetime = .keepAlways
		add(idleShot)
		app.buttons["Cancel"].tap()
	}

	private func signedInApp() throws -> XCUIApplication {
		let app = try FoldableUITests.launch(environment: [:])
		app.buttons["Sessions"].firstMatch.tap()
		return app
	}
}
