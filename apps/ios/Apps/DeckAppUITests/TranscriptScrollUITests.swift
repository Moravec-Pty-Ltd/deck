import XCTest

/// Opening a session lands on its latest message and stays there while rows
/// settle and previews load. Needs a deck server with a claude session titled
/// "long transcript" whose last reply reads "Reply 60, the latest message."
/// (seeded alongside the file-preview fixture).
final class TranscriptScrollUITests: XCTestCase {
	override func setUp() {
		continueAfterFailure = false
	}

	func testOpensAtTheLatestMessage() throws {
		let app = try FoldableUITests.launch(environment: [:])
		app.buttons["Sessions"].firstMatch.tap()
		let row = app.staticTexts["long transcript"].firstMatch
		XCTAssertTrue(row.waitForExistence(timeout: 20), "needs the seeded session\n\(app.debugDescription.prefix(3000))")
		row.tap()

		let latest = app.staticTexts["Reply 60, the latest message."]
		XCTAssertTrue(latest.waitForExistence(timeout: 20), "the latest message should be rendered, i.e. scrolled into view (lazy rows off screen do not exist)")
		let window = app.windows.firstMatch.frame
		// Give lazy rows and the preview thumbnails time to settle.
		sleep(3)
		XCTAssertTrue(latest.isHittable, "the latest message should be on screen without scrolling")
		XCTAssertTrue(window.contains(latest.frame), "latest message frame \(latest.frame) should sit inside the window \(window)")
		let composer = app.textFields["Message"]
		XCTAssertTrue(composer.exists)
		XCTAssertLessThan(latest.frame.maxY, composer.frame.minY, "the latest message sits just above the composer")

		// A reader who scrolls up is left there.
		app.swipeDown()
		app.swipeDown()
		sleep(2)
		XCTAssertFalse(latest.isHittable, "scrolling up must not snap back to the end")
	}

	func testSearchHitOpensAtTheHitNotTheEnd() throws {
		let app = try FoldableUITests.launch(environment: [:])
		app.buttons["Sessions"].firstMatch.tap()
		let field = app.searchFields.firstMatch
		if !field.waitForExistence(timeout: 5) { app.buttons["Search"].firstMatch.tap() }
		XCTAssertTrue(field.waitForExistence(timeout: 10))
		field.tap()
		field.typeText("Step 30?")
		let hit = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Step 30?'")).firstMatch
		XCTAssertTrue(hit.waitForExistence(timeout: 20), "no search hit\n\(app.debugDescription.prefix(3000))")
		hit.tap()

		let target = app.staticTexts["Step 30?"]
		XCTAssertTrue(target.waitForExistence(timeout: 20))
		sleep(3)
		XCTAssertTrue(target.isHittable, "the hit should be on screen")
		XCTAssertFalse(app.staticTexts["Reply 60, the latest message."].exists, "the end should not have won over the hit")
	}
}
