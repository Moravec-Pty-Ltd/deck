import XCTest

/// Drives the real app against a running deck server. Point it at one with
/// `DECK_UITEST_URL` / `DECK_UITEST_TOKEN` (see the repo README); without them
/// the tests skip, so they never fail a machine that has no deck to talk to.
///
/// Both tests open the rename sheet and cancel: this runs against a live deck,
/// so it must not rename real sessions.
final class RenameSessionUITests: XCTestCase {
	override func setUp() {
		continueAfterFailure = false
	}

	/// Swiping a row reveals Rename beside Delete, and it opens the sheet with
	/// the current name already in the field.
	func testSwipeToRenameOpensSheetPrefilled() throws {
		let app = try signedInApp()

		let list = app.collectionViews.firstMatch
		XCTAssertTrue(list.waitForExistence(timeout: 20), "sessions list never appeared")
		let row = FoldableUITests.firstSessionRow(in: list)
		XCTAssertTrue(row.waitForExistence(timeout: 20), "no session rows to swipe")

		row.swipeLeft()
		let rename = app.buttons["Rename"]
		XCTAssertTrue(rename.waitForExistence(timeout: 5), "swipe did not reveal Rename")
		rename.tap()

		XCTAssertTrue(
			app.navigationBars["Rename session"].waitForExistence(timeout: 5),
			"rename sheet did not open")
		let field = app.textFields["renameField"]
		XCTAssertTrue(field.waitForExistence(timeout: 5), "rename sheet has no name field")
		let prefilled = field.value as? String ?? ""
		XCTAssertFalse(prefilled.isEmpty, "rename field did not start with the current name")
		XCTAssertTrue(app.buttons["renameSave"].isEnabled, "Save is off with a name in the field")

		app.buttons["Cancel"].tap()
		XCTAssertTrue(list.waitForExistence(timeout: 5))
		XCTAssertEqual(app.state, .runningForeground, "app died dismissing the rename sheet")
	}

	/// The same sheet from tapping the session's title, and an empty name must
	/// not be saveable.
	func testTappingTheTitleRenamesAndRejectsAnEmptyName() throws {
		let app = try signedInApp()

		let list = app.collectionViews.firstMatch
		XCTAssertTrue(list.waitForExistence(timeout: 20))
		let row = FoldableUITests.firstSessionRow(in: list)
		XCTAssertTrue(row.waitForExistence(timeout: 20))
		row.tap()

		let rename = app.buttons["renameSession"]
		XCTAssertTrue(rename.waitForExistence(timeout: 20), "the title is not a rename button")
		rename.tap()

		let field = app.textFields["renameField"]
		XCTAssertTrue(field.waitForExistence(timeout: 5), "rename sheet did not open")
		field.tap()
		// Clear it: a name of nothing but spaces must leave Save off.
		let existing = (field.value as? String ?? "").count
		field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing))
		field.typeText("   ")
		XCTAssertFalse(app.buttons["renameSave"].isEnabled, "Save stayed on for an empty name")

		app.buttons["Cancel"].tap()
		XCTAssertEqual(app.state, .runningForeground, "app died dismissing the rename sheet")
	}

	private func signedInApp() throws -> XCUIApplication {
		let app = try FoldableUITests.launch(environment: [:])
		app.buttons["Sessions"].firstMatch.tap()
		return app
	}
}
