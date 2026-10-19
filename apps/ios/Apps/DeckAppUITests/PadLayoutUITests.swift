import XCTest

/// On an iPad the app runs full size in either orientation, with the sessions
/// list beside the open session rather than pushed over it. Run on an iPad
/// simulator against the demo-fixture server.
final class PadLayoutUITests: XCTestCase {
	override func setUp() {
		continueAfterFailure = false
	}

	override func tearDown() {
		XCUIDevice.shared.orientation = .portrait
	}

	func testListSitsBesideTheSessionInBothOrientations() throws {
		let app = try FoldableUITests.launch(environment: [:])
		app.buttons["Sessions"].firstMatch.tap()
		let row = app.staticTexts["long transcript"].firstMatch
		XCTAssertTrue(row.waitForExistence(timeout: 20), "needs the fixture sessions\n\(app.debugDescription.prefix(3000))")
		row.tap()
		XCTAssertTrue(app.navigationBars["long transcript"].waitForExistence(timeout: 20))

		for orientation in [UIDeviceOrientation.landscapeLeft, .portrait] {
			XCUIDevice.shared.orientation = orientation
			sleep(2)
			let window = app.windows.firstMatch.frame
			XCTAssertGreaterThan(window.width, 700, "the app should fill the iPad, not run letterboxed")
			XCTAssertTrue(app.staticTexts["file previews"].exists, "the list should stay beside the session (\(orientation.rawValue))\n\(app.debugDescription.prefix(2500))")
			XCTAssertTrue(app.navigationBars["long transcript"].exists)
		}
	}

	/// The whole row switches session, not just its label. In the wide layout a
	/// row is a plain Button, which hit-tests only what it draws, so the gaps
	/// between the title, the chips and the timestamp used to miss entirely.
	/// This clicks the far right of the row, past every piece of text.
	func testClickingTheEmptyPartOfARowOpensIt() throws {
		let app = try FoldableUITests.launch(environment: [:])
		app.buttons["Sessions"].firstMatch.tap()

		// Open a different session first, so opening this one is a real change.
		let other = app.staticTexts["long transcript"].firstMatch
		XCTAssertTrue(other.waitForExistence(timeout: 20), "needs the fixture sessions")
		other.tap()
		XCTAssertTrue(app.navigationBars["long transcript"].waitForExistence(timeout: 20))

		let label = app.staticTexts["file previews"].firstMatch
		XCTAssertTrue(label.waitForExistence(timeout: 10))

		// The row cell, not the label: an offset from the label is measured in
		// label widths, which walks straight out of the sidebar.
		let row = app.cells.containing(.staticText, identifier: "file previews").firstMatch
		XCTAssertTrue(row.waitForExistence(timeout: 10), "could not find the row cell")

		// Bottom right of the row: past the chips, below the timestamp, blank in
		// every row. Assert it really is blank before relying on it.
		let blank = row.coordinate(withNormalizedOffset: CGVector(dx: 0.88, dy: 0.82))
		let point = blank.screenPoint
		for text in row.staticTexts.allElementsBoundByIndex where text.exists {
			XCTAssertFalse(
				text.frame.contains(point),
				"the spot meant to be blank sits on \"\(text.label)\"; pick another")
		}
		blank.tap()

		XCTAssertTrue(
			app.navigationBars["file previews"].waitForExistence(timeout: 20),
			"clicking the blank part of a row did not switch session\n\(app.debugDescription.prefix(2500))")
	}
}
