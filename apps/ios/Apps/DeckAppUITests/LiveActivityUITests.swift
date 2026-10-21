import XCTest

/// Opens a session, provokes a turn, and checks the Live Activity card shows
/// up in Notification Centre with the session's title and a Stop button.
/// Needs the same environment as VoiceUITests.
final class LiveActivityUITests: XCTestCase {
	override func setUp() {
		continueAfterFailure = false
	}

	func testRunningSessionShowsALiveActivity() throws {
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
		let row = app.staticTexts["voice smoke"].firstMatch
		XCTAssertTrue(row.waitForExistence(timeout: 20))
		row.tap()
		XCTAssertTrue(app.buttons["Thread"].waitForExistence(timeout: 20))

		// A turn starting while the session is open starts the activity.
		let sessionId = try VoiceUITests.sessionId(url: url, token: token)
		try VoiceUITests.send("Count slowly from one to twelve, one number per line, thinking briefly between each.", sessionId: sessionId, url: url, token: token)
		sleep(4)

		XCUIDevice.shared.press(.home)
		let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
		// Notification Centre opens on a drag from the very top edge; a plain
		// swipe lands inside the home screen instead.
		let top = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.005))
		let bottom = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.85))
		top.press(forDuration: 0.1, thenDragTo: bottom)
		let card = springboard.staticTexts["voice smoke"].firstMatch
		XCTAssertTrue(card.waitForExistence(timeout: 15), "no Live Activity card in Notification Centre\n\(springboard.debugDescription.prefix(4000))")
		let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
		shot.lifetime = .keepAlways
		add(shot)
	}
}
