import XCTest

/// Drives the real app against a running deck server. Point it at one with
/// `DECK_UITEST_URL` / `DECK_UITEST_TOKEN` (see the repo README); without them
/// the tests skip, so they never fail a machine that has no deck to talk to.
final class SwipeDeleteUITests: XCTestCase {
	private var serverURL: String? { ProcessInfo.processInfo.environment["DECK_UITEST_URL"] }
	private var token: String? { ProcessInfo.processInfo.environment["DECK_UITEST_TOKEN"] }

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
		let row = list.cells.element(boundBy: 0)
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
		XCTAssertTrue(list.cells.element(boundBy: 0).waitForExistence(timeout: 20))

		for index in 0..<6 {
			let row = list.cells.element(boundBy: index % max(1, min(3, list.cells.count)))
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

	private func signedInApp() throws -> XCUIApplication {
		guard let serverURL, let token else {
			throw XCTSkip("set DECK_UITEST_URL and DECK_UITEST_TOKEN to run the UI tests")
		}
		let app = XCUIApplication()
		app.launch()

		// Fresh install: sign in through the manual fields (the QR path needs a camera).
		let manual = app.buttons["Enter details manually"]
		if manual.waitForExistence(timeout: 5) {
			manual.tap()
			let urlField = app.textFields["Server URL"]
			XCTAssertTrue(urlField.waitForExistence(timeout: 5))
			urlField.tap()
			urlField.typeText(serverURL)
			let tokenField = app.secureTextFields["Token"]
			tokenField.tap()
			tokenField.typeText(token)
			app.buttons["Connect"].tap()
		}

		XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 20), "never got past sign-in")
		app.tabBars.buttons["Sessions"].tap()
		return app
	}
}
